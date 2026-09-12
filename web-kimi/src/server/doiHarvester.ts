import { harvestArticle, ArticleSet } from "./articleHarvester.js";
import { harvestReferences, ReferenceSet } from "./referenceHarvester.js";

const EMAIL = process.env.NCBI_EMAIL ?? process.env.ENTREZ_EMAIL ?? "taichi_shimizu@med.uoeh-u.ac.jp";
const TOOL = "llamaindex-doi-harvest";
const HEADERS = { "User-Agent": `${TOOL}/1.0 (${EMAIL})` };

export type PublisherId = "springer" | "sage" | "elsevier" | "wiley" | "unknown";
export type DoiHarvestSource = PublisherId | "europepmc" | "unresolved";

export interface DoiHarvestResult {
  ok: boolean;
  doi: string;
  source: DoiHarvestSource;
  publisher: PublisherId;
  pmcid?: string;
  publisherUrl?: string;
  sourceUrl?: string;
  article?: ArticleSet;
  reference?: ReferenceSet;
  articleError?: string;
  referenceError?: string;
  message?: string;
}

interface PublisherRoute {
  id: PublisherId;
  // DOI接頭辞での判定（ネットワーク不要の一次判定）
  prefixes: string[];
  // Crossrefのpublisher名での判定（未知の接頭辞に対する二次判定）
  namePattern: RegExp;
  // サーバ側で全文JATS XMLを取得する。取得不可の出版社では undefined。
  fetchJats?: (doi: string) => Promise<string | null>;
  // 記事ページのURL。doi.orgのリダイレクトはbot検査ページを返すことがあるため、
  // 図の絶対URL補完やAuthorYear形式のID生成にはこちらを使う。
  articleUrl?: (doi: string) => string;
  // 自動取得できなかったときに表示する案内（APIキーの有無で変わるため実行時に評価する）。
  hint: () => string;
}

// "10.xxxx/yyyy" 形式に正規化する（https://doi.org/... や doi: 接頭辞を許容）
function normalizeDoi(input: string): string {
  return input
    .trim()
    .replace(/^doi:\s*/i, "")
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^\/+/, "");
}

// Springer Nature OA APIからJATS XMLを取得する（BMC/SpringerOpen等のOA論文が対象）。
// APIキーは https://dev.springernature.com で無料登録して SPRINGER_API_KEY に設定する。
function springerApiKey(): string {
  return process.env.SPRINGER_API_KEY ?? process.env.SPRINGER_open_access_api_key ?? "";
}

async function fetchSpringerJats(doi: string): Promise<string | null> {
  const apiKey = springerApiKey();
  if (!apiKey) return null;

  const url = new URL("https://api.springernature.com/openaccess/jats");
  url.searchParams.set("q", `doi:${doi}`);
  url.searchParams.set("api_key", apiKey);

  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return null;
  const body = await res.text();

  // OA APIはJATSを <response><records>…</records></response> で包んで返すため、
  // 既存のJATSパーサに渡せるよう <article> 要素だけを取り出す。
  const article = body.match(/<article\b[\s\S]*<\/article>/i)?.[0];
  if (!article || !article.includes("<body")) return null;
  return article;
}

// SAGEとWileyはサーバ側からの全文取得がbot対策・契約認証で弾かれるため、
// ブラウザのブックマークレット（同一オリジンで取得してPOST）に委ねる。
const PUBLISHER_ROUTES: PublisherRoute[] = [
  {
    id: "springer",
    prefixes: ["10.1007", "10.1186", "10.1038", "10.1057", "10.1140", "10.1245"],
    namePattern: /springer|biomed\s*central|nature\s+publishing/i,
    fetchJats: fetchSpringerJats,
    articleUrl: (doi) => `https://link.springer.com/article/${doi}`,
    hint: () =>
      springerApiKey()
        ? "Springer OA APIに全文XMLがありませんでした（OA対象外の可能性があります）。"
        : "Springer/BMCのXML自動取得には、.env に SPRINGER_API_KEY（または SPRINGER_open_access_api_key）を設定してサーバを再起動してください。",
  },
  {
    id: "sage",
    prefixes: ["10.1177", "10.1191"],
    namePattern: /sage/i,
    hint: () =>
      "SAGEの /doi/full-xml/ はブラウザのセッション（credentials:same-origin）でのみ取得できます。記事ページでSAGE Importブックマークレットを実行してください。",
  },
  {
    id: "elsevier",
    prefixes: ["10.1016", "10.1053", "10.1067"],
    namePattern: /elsevier/i,
    hint: () => "Elsevierの全文XMLはdev.elsevier.comのAPIキーと機関契約が必要です。現状はブックマークレットで取り込んでください。",
  },
  {
    id: "wiley",
    prefixes: ["10.1002", "10.1111", "10.1046", "10.1113"],
    namePattern: /wiley|blackwell/i,
    hint: () => "WileyはTDM APIがPDFのみのため、記事ページでブックマークレットを実行してください。",
  },
];

// Crossrefから出版社名を引く（DOI接頭辞で判定できなかった場合の二次判定）。
async function fetchCrossrefPublisher(doi: string): Promise<string> {
  try {
    const res = await fetch(`https://api.crossref.org/works/${doi}`, { headers: HEADERS });
    if (!res.ok) return "";
    const data: any = await res.json();
    return String(data?.message?.publisher ?? "");
  } catch {
    return "";
  }
}

async function detectPublisherRoute(doi: string): Promise<PublisherRoute | null> {
  const prefix = doi.split("/")[0];
  const byPrefix = PUBLISHER_ROUTES.find((route) => route.prefixes.includes(prefix));
  if (byPrefix) return byPrefix;

  const name = await fetchCrossrefPublisher(doi);
  if (!name) return null;
  return PUBLISHER_ROUTES.find((route) => route.namePattern.test(name)) ?? null;
}

// Europe PMC検索APIでDOI→PMCIDを引き、OA全文JATS XMLを取得する。
async function fetchEuropePmcFullTextXml(doi: string): Promise<{ xml: string; pmcid: string } | null> {
  const searchUrl = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
  searchUrl.searchParams.set("query", `DOI:"${doi}"`);
  searchUrl.searchParams.set("format", "json");
  searchUrl.searchParams.set("resultType", "core");
  searchUrl.searchParams.set("pageSize", "1");

  const searchRes = await fetch(searchUrl, { headers: HEADERS });
  if (!searchRes.ok) return null;
  const searchData: any = await searchRes.json();
  const pmcid: string | undefined = searchData?.resultList?.result?.[0]?.pmcid;
  if (!pmcid) return null;

  const xmlRes = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`, {
    headers: HEADERS,
  });
  if (!xmlRes.ok) return null;
  const xml = await xmlRes.text();
  if (!xml.includes("<article") || !xml.includes("<body")) return null;
  return { xml, pmcid };
}

// doi.orgのリダイレクトを追って出版社ページの実URLを得る（見つからない場合は空文字）。
async function resolveDoiUrl(doi: string): Promise<string> {
  try {
    const res = await fetch(`https://doi.org/${doi}`, { redirect: "follow", headers: HEADERS });
    return res.url || "";
  } catch {
    return "";
  }
}

// 取得済みJATS XMLをArticleSet/ReferenceSetとして保存する。
async function importJats(
  doi: string,
  xml: string,
  source: DoiHarvestSource,
  publisher: PublisherId,
  sourceUrl: string,
  extra: Partial<DoiHarvestResult> = {},
): Promise<DoiHarvestResult> {
  const result: DoiHarvestResult = { ok: false, doi, source, publisher, sourceUrl, ...extra };

  try {
    result.article = await harvestArticle({ jatsXml: xml, sourceUrl });
  } catch (e: any) {
    result.articleError = String(e?.message ?? e);
  }
  try {
    result.reference = await harvestReferences({ jatsXml: xml, sourceUrl });
  } catch (e: any) {
    result.referenceError = String(e?.message ?? e);
  }

  result.ok = Boolean(result.article || result.reference);
  if (!result.ok) {
    result.message = [result.articleError, result.referenceError].filter(Boolean).join(" / ") || "取り込みに失敗しました";
  }
  return result;
}

// DOIを渡すだけで全文JATS XMLの取得元を自動判定し、ArticleSet/ReferenceSetとして保存する。
// 判定順: DOIから出版社を特定しその出版社APIを試す → Europe PMC(OA)を検索。
// どちらでも取れない場合は出版社URLと取り込み方法の案内を返す。
export async function harvestByDoi(doiInput: string): Promise<DoiHarvestResult> {
  const doi = normalizeDoi(doiInput);
  if (!doi) throw new Error("DOIを入力してください");

  const route = await detectPublisherRoute(doi);
  const publisher = route?.id ?? "unknown";

  if (route?.fetchJats) {
    const xml = await route.fetchJats(doi);
    if (xml) {
      return importJats(doi, xml, route.id, publisher, route.articleUrl?.(doi) ?? `https://doi.org/${doi}`);
    }
  }

  const pmc = await fetchEuropePmcFullTextXml(doi);
  if (pmc) {
    return importJats(doi, pmc.xml, "europepmc", publisher, `https://pmc.ncbi.nlm.nih.gov/articles/${pmc.pmcid}/`, {
      pmcid: pmc.pmcid,
    });
  }

  const publisherUrl = await resolveDoiUrl(doi);
  const hint = route?.hint() ?? "対応済みの出版社APIがありません。記事ページでブックマークレットを実行してください。";
  return {
    ok: false,
    doi,
    source: "unresolved",
    publisher,
    publisherUrl: publisherUrl || undefined,
    message: `全文XMLを自動取得できませんでした（出版社: ${publisher}）。${hint}${
      publisherUrl ? ` 記事ページ: ${publisherUrl}` : ""
    }`,
  };
}
