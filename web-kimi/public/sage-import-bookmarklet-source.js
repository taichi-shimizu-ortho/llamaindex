// SAGE Import ブックマークレット（web-kimi / API: localhost:5176）
//
// journals.sagepub.com の論文ページで実行する。
// 1. ページ内の <meta name="citation_doi"> かURLパスからDOIを取り出す
// 2. そのDOIで /doi/full-xml/{doi} を credentials:"same-origin" で取得する
//    （ブラウザのセッションを使うため、サーバ側からは取得できない全文XMLが取れる）
// 3. JATS XML（<article> / <article-meta> / <body>）であることを確認する
// 4. ページのHTMLと一緒に /api/import/ors へ送る
//    article JSONはXML優先、reference JSONはDOI/PMIDを持つHTMLのbibr優先で作られる
//
// XMLが取れなかった場合は例外で止めず、HTMLのみを送ってフォールバックさせる。

(async () => {
  const API = "http://localhost:5176/api/import/ors";

  const toast = (text, ok) => {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "max-width:420px",
      "padding:12px 16px",
      "border-radius:8px",
      "font:14px/1.5 system-ui,sans-serif",
      "color:#fff",
      "white-space:pre-wrap",
      `background:${ok ? "#1f7a4d" : "#a33"}`,
    ].join(";");
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 12000);
    return el;
  };

  const doi =
    document.querySelector('meta[name="citation_doi"]')?.content?.trim() ||
    location.pathname.match(/10\.\d{4,9}\/[^/?#]+/)?.[0];

  if (!doi) return toast("DOIが見つかりません。論文ページで実行してください。", false);

  const progress = toast(`取得中: ${doi}`, true);

  // DOIの "/" はURLエンコードしない。パスとしてそのまま維持する。
  let jatsXml = "";
  try {
    const res = await fetch(`${location.origin}/doi/full-xml/${doi}`, { credentials: "same-origin" });
    if (res.ok) {
      const text = await res.text();
      if (text.includes("<article") && text.includes("<article-meta") && text.includes("<body")) {
        jatsXml = text;
      }
    }
  } catch {
    /* XMLが取れなくてもHTML抽出で続行する */
  }

  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceUrl: location.href,
        html: document.documentElement.outerHTML,
        title: document.title,
        jatsXml,
      }),
    });
    if (!(res.headers.get("content-type") || "").includes("application/json")) {
      throw new Error("API server is down or returned non-JSON. (HTTP " + res.status + ")");
    }
    const data = await res.json();
    progress.remove();

    if (!res.ok || !data.ok) {
      return toast(`取り込み失敗: ${data.error ?? res.status}`, false);
    }
    const article = data.article ? `article ${data.article.id} (${data.article.extractionSource})` : "article なし";
    const reference = data.reference ? `reference ${data.reference.totalReferences}件` : "reference なし";
    toast(`取り込み完了\n${article}\n${reference}`, true);
  } catch (e) {
    progress.remove();
    toast(`APIに接続できません（web-kimiは起動していますか）: ${e}`, false);
  }
})();
