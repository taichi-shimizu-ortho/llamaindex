"""Convert saved MSC-OXT publisher MHTML into local structured article sets.

This command only reads local archives. It never opens publisher URLs, downloads
images, calls an LLM, or edits the live library. Missing assets stay in warnings.
Use --help for the manifest and inventory inputs; install dependencies from
scripts/offline-mhtml-requirements.txt into the project virtual environment.
"""
from __future__ import annotations
import argparse
import base64
import copy
import email
import hashlib
import io
import json
import mimetypes
import re
from datetime import datetime, timezone
from email import policy
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit, urlunsplit
from bs4 import BeautifulSoup, Tag
from PIL import Image

# Configuration is populated by main; importing this module performs no I/O.
STAGE = None
INPUT_DIR = None
SUPPLEMENT_DIR = None
INVENTORY = None
BY_NAME = {}
NOW = datetime.now(timezone.utc).isoformat()
EXCLUDED = re.compile(r'acknowledg|funding|conflicts?|competing interest|disclosure|author.?s?.? contributions?|author notes|ethical|ethics|^consent$|data availability|abbreviations|supplementary|supporting information|publisher.?s note|copyright', re.I)
EXCLUDED = re.compile(EXCLUDED.pattern + r'|^Statements$|ORCID|Footnotes|authorship contribution|Declaration of AI|Institutional Review|Informed Consent|Supplemental Material', re.I)
PLATFORMS = {
 'frontiers': ['Feixiang2023','Wang2024'],
 'mdpi': ['Breuil2021','Ferrero2021','Pampanella2024','Petrocelli2023','Philippon2025','Roux2020','Roux2023'],
 'wiley': ['Ahmed2021','Hatakeyama2017','Kim2010','Murata2020'],
 'sage': ['Colaianni2014','Murata2018','Nakashima2022','Utsunomiya2013','Zhang2026','Tamma2009'],
 'oup': ['Elabd2008','Noiseux2012'], 'sd': ['Santos2018'], 'iop': ['Wang2025'], 'bjr': ['Cheng2024']}
def platform(name):return next(k for k,v in PLATFORMS.items() if name in v)

def norm(x):
    return re.sub(r'\s+', ' ', x or '').strip()

def text_of(node):
    clone = BeautifulSoup(str(node), 'html.parser')
    for t in clone.select('script,style,button,.figure-extra,.citation-links,.external-links'):
        t.decompose()
    submap = str.maketrans('0123456789+-=()', '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎')
    supmap = str.maketrans('0123456789+-=()ni', '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ')
    for t in clone.select('sub,sup'):
        v = t.get_text('', strip=True)
        if t.name == 'sup' and t.find('a'):
            t.replace_with('[' + v + ']')
        else:
            t.replace_with(v.translate(submap if t.name == 'sub' else supmap))
    for t in list(clone.select('div,p,li,br')):
        t.insert_before(' ')
        t.insert_after(' ')
    return norm(clone.get_text()).replace(' [ ', ' [').replace(' ] ', '] ')

def heading(node):
    return re.sub(r'\b([A-Z])\s+(?=[a-z])', r'\1', norm(node.get_text(' ', strip=True))).rstrip(':')

def kind(title):
    if re.search('abstract', title, re.I): return 'abstract'
    if re.search('method|material|experimental|statistical', title, re.I): return 'methods'
    if re.search('introduction|background', title, re.I): return 'intro'
    if re.search('result', title, re.I): return 'results'
    if re.search('discussion', title, re.I): return 'discussion'
    if re.search('conclusion|summary', title, re.I): return 'conclusion'
    return 'other'

def section(title, type_, paragraphs):
    return {'title': title, 'type': type_, 'content': '\n\n'.join(paragraphs), 'paragraphs': paragraphs, 'subsections': []}

def canonical_url(url, base):
    p = urlsplit(urljoin(base, url).strip())
    return unquote(urlunsplit((p.scheme, p.netloc, p.path, p.query, '')))

def parse_mhtml(path):
    message = email.message_from_bytes(path.read_bytes(), policy=policy.default)
    url = message.get('Snapshot-Content-Location') or ''
    htmls, assets = [], {}
    for part in message.walk():
        data = part.get_payload(decode=True) or b''
        ct = part.get_content_type()
        loc = str(part.get('Content-Location') or '')
        if ct == 'text/html':
            htmls.append((canonical_url(loc, url) == canonical_url(url, url), len(data), data.decode(part.get_content_charset() or 'utf-8', errors='replace')))
        if ct.startswith('image/'):
            if loc: assets[canonical_url(loc, url)] = (ct, data, loc)
            cid = str(part.get('Content-ID') or '').strip('<>')
            if cid: assets['cid:' + cid] = (ct, data, loc)
    return url, max(htmls)[2], assets

def roots(soup, name):
    root_selector = {'wiley': '.article-section__full', 'mdpi': '#article-contents', 'bjr': '#article-body .body', 'sage': '#bodymatter', 'oup': '.widget-ArticleFulltext', 'frontiers': '.ArticleContent', 'sd': '#body', 'iop': '.wd-jnl-art-full-text'}[platform(name)]
    body = soup.select_one(root_selector)
    if body is None: raise ValueError(f'{name}: article body is missing')
    result = BeautifulSoup('<article></article>', 'html.parser').article
    abstract_selector='.article-section__abstract,section.abstract,#html-abstract,#abstract,.abstract,.ArticleContent > #h1,.wd-jnl-art-abstract'
    abstract = soup.select_one('#ab0005') if platform(name)=='sd' else soup.select_one(abstract_selector)
    if abstract:
        wrapper = BeautifulSoup('<section><h2>Abstract</h2><p></p></section>', 'html.parser').section
        abstract_text = re.sub(r'^Abstract\s*', '', text_of(abstract), flags=re.I)
        abstract_text = re.sub(r'\s*Disclosure of potential conflicts of interest is found at the end of this article\.?$', '', abstract_text, flags=re.I)
        wrapper.p.string = abstract_text
        result.append(wrapper)
    body_copy = copy.deepcopy(body)
    for x in list(body_copy.select(abstract_selector)):
        if x.parent: x.decompose()
    for h in list(body_copy.find_all(['h2','h3'])):
        if heading(h).lower()=='abstract':h.decompose()
    if name=='Murata2020':
        for h in body_copy.find_all(['h3','h4','h5']):h.name='h'+str(int(h.name[1])-1)
    # Several publishers leave introduction paragraphs before the first heading.
    body_copy.insert(0, BeautifulSoup('<h2>Introduction</h2>','html.parser').h2)
    result.append(body_copy)
    return result, body

def table_markdown(table):
    rows = []
    for tr in table.select('tr'):
        cells = tr.find_all(['td','th'], recursive=False)
        if cells: rows.append([text_of(c).replace('|', '\\|') for c in cells])
    if not rows: return ''
    width = max(map(len, rows))
    rows = [r + [''] * (width-len(r)) for r in rows]
    return '\n'.join(['| ' + ' | '.join(rows[0]) + ' |', '| ' + ' | '.join(['---'] * width) + ' |'] + ['| ' + ' | '.join(r) + ' |' for r in rows[1:]])

def extract_tables(root, name):
    out, warnings, seen = [], [], set()
    wraps = root.select('.html-table-wrap,.article-table-content,.article-table-wrapper,.table-wrap,.table-section,figure.table,.ArticleTable,div.boxout:has(table)')
    for w in wraps:
        if any(p in wraps for p in w.parents): continue
        ancestor_section = w.find_parent('section')
        parent_heading = ancestor_section.find(['h2','h3'], recursive=False) if ancestor_section else None
        if parent_heading and EXCLUDED.search(heading(parent_heading)): continue
        caption = w.select_one('.html-table_wrap_discription,.table-caption,figcaption,caption,.table__caption,.ArticleTable__caption,.ArticleTable__title')
        if not caption and 'boxout' in (w.get('class') or []):caption=w.find('p')
        label = text_of(caption) if caption else ''
        if w.select_one('.ArticleTable__description'):label+=' '+text_of(w.select_one('.ArticleTable__description'))
        table = w.find('table')
        if not table:
            if label and label not in seen:
                warnings.append(f'Table body not embedded: {label}')
                seen.add(label)
            continue
        if len(table.select('tr')) < 2: continue
        md = table_markdown(table)
        if md and md not in seen:
            seen.add(md)
            title_match = re.search(r'Table\s*\d+[A-Za-z]?', label, re.I)
            title = title_match.group() if title_match else f'Table {len(out)+1}'
            out.append(section(title, 'table', [label + '\n\n' + md if label else md]))
    for table in root.select('table'):
        if table.find_parent(class_='html-table_wrap_td') or any(p in wraps for p in table.parents): continue
        if 'Publisher' in table.get_text() and len(table.select('tr')) < 3: continue
        ancestor_section = table.find_parent('section')
        parent_heading = ancestor_section.find(['h2','h3'], recursive=False) if ancestor_section else None
        if parent_heading and EXCLUDED.search(heading(parent_heading)): continue
        md = table_markdown(table)
        if md and md not in seen and len(table.select('tr')) > 1:
            seen.add(md);out.append(section(f'Table {len(out)+1}', 'table', [md]))
    return out, warnings

def extract_figures(root, name, url, assets, output):
    candidates = root.select('.html-fig-wrap,figure')
    out, warnings, details, seen = [], [], [], set()
    for fig in candidates:
        if any(p in candidates for p in fig.parents): continue
        if fig.find('table') or 'table' in (fig.get('class') or []): continue
        img = fig.find('img')
        if not img: continue
        cap = fig.select_one('figcaption,.html-fig_description,.captions')
        label = fig.select_one('.figure__title,.fig-label,.figure-label,.label')
        if not label and cap: label = cap.find(['b','strong'])
        rawlabel = text_of(label) if label else ''
        legend = text_of(cap) if cap else img.get('alt','')
        fid=re.search(r'(?:^|[^a-z])F(\d+)$',fig.get('id',''),re.I)
        labels=[rawlabel,img.get('alt',''),fig.get('data-toolbar-title',''),('Figure '+fid.group(1)) if fid else '',legend]
        match=next((m for v in labels if (m:=re.search(r'(?:Fig(?:ure)?\.?)\s*(\d+)\s*(?:\(([a-z])\))?',v,re.I))),None)
        if not match: continue
        panel=match.group(2) if match.lastindex and match.lastindex>=2 else None
        title = 'Figure ' + match.group(1) + (f' ({panel})' if panel else '')
        if title in seen: continue
        seen.add(title)
        choices = [img.get(x,'') for x in ['data-original','data-large','data-lg-src','data-src','src']]
        choices += [v.strip().split(' ')[0] for s in fig.select('source[srcset],img[srcset]') for v in s.get('srcset','').split(',') if v.strip()]
        asset = next((assets[canonical_url(v,url)] for v in choices if v and canonical_url(v,url) in assets), None)
        if not asset:
            # Frontiers embeds a responsive proxy variant with a different width.
            # Match the complete original URL inside an already-saved proxy URL.
            originals=[canonical_url(v,url).split('/https://')[-1] for v in choices if '/files/Articles/' in v]
            variants=[a for loc,a in assets.items() if '/api/ipx/' in loc and any(loc.endswith('/https://'+v) for v in originals)]
            if len(variants)==1:asset=variants[0]
        if not asset:
            # Saved Chromium resources can add a cache/version query string.
            # Resolve only an unambiguous already-embedded host/path match.
            for candidate in choices:
                if not candidate or candidate.startswith('data:'): continue
                wanted = urlsplit(canonical_url(candidate,url))
                matches = [a for loc,a in assets.items() if (urlsplit(loc).scheme,urlsplit(loc).netloc,urlsplit(loc).path)==(wanted.scheme,wanted.netloc,wanted.path)]
                if len(matches)==1:
                    asset=matches[0];break
        if not asset:
            data_url = next((v for v in choices if v.startswith('data:image/') and ';base64,' in v), '')
            if data_url:
                header, encoded = data_url.split(',',1)
                payload = base64.b64decode(encoded)
                if len(payload)>500: asset = (header[5:].split(';')[0], payload, data_url[:70])
        if not asset:
            warnings.append(f'Figure image not embedded: {title}')
            out.append(section(title, 'figure', [legend + '\n\n[Image unavailable in saved MHTML]']))
            continue
        media, payload, source = asset
        suffix = {'image/jpeg':'.jpg','image/png':'.png','image/gif':'.gif','image/svg+xml':'.svg','image/webp':'.webp'}.get(media) or mimetypes.guess_extension(media) or '.bin'
        width = height = None
        try:
            image = Image.open(io.BytesIO(payload));width,height = image.size
            if width<5 and height<5: raise ValueError('placeholder image')
            if image.format in {'TIFF','BMP'}:
                buffer=io.BytesIO();image.save(buffer,format='PNG');payload=buffer.getvalue();suffix='.png'
        except ValueError:
            warnings.append(f'Figure is a placeholder: {title}');continue
        except Exception as e:
            if media!='image/svg+xml': warnings.append(f'Image inspection failed for {title}: {e}')
        filename = re.sub(r'[^A-Za-z0-9]+','_',title).strip('_')+suffix
        path = output / 'figures' / filename;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(payload)
        local = f'/raw_html/{name}_figures/{filename}'
        out.append(section(title, 'figure', [f'[Image URL: {local}]\n\n{legend}']))
        details.append({'title':title,'filename':filename,'source':source,'bytes':len(payload),'width':width,'height':height})
    return out,warnings,details

def extract_body(root):
    node = copy.deepcopy(root)
    for x in list(node.select('script,style,noscript,nav,header,footer,button,figure,.html-fig-wrap,.html-table-wrap,.fig,.table-section,.article-table-content,.table-wrap,.ArticleFigure,.ArticleTable,div.boxout:has(table),table,.ref-list,.article-section__references,#html-references_list,#html-keywords,#html-graphical,#html-copyright,.gift-access-description,.figPopup,.figPopupLink')):
        if x.parent: x.decompose()
    sections=[];current=None;sub=None;excluded=False;stopped=False
    def push(t):
        nonlocal current
        if not t or excluded:return
        if current is None:
            current=section('Introduction','intro',[]);sections.append(current)
        target=sub if sub is not None else current
        if not target['paragraphs'] or target['paragraphs'][-1]!=t:target['paragraphs'].append(t)
    def walk(x):
        nonlocal current,sub,excluded,stopped
        if stopped or not isinstance(x,Tag):return
        if x.name in ['h2','h3','h4','h5']:
            title=heading(x)
            if not title:return
            if re.fullmatch(r'references?|bibliography',title,re.I):stopped=True;return
            if EXCLUDED.search(title):excluded=True;sub=None;return
            if x.name=='h2' or current is None:
                current=section(title,kind(title),[]);sections.append(current);sub=None;excluded=False
            elif not excluded:
                sub={'title':title,'content':'','paragraphs':[]};current['subsections'].append(sub)
            return
        classes=x.get('class') or []
        is_para=x.name in ['p','li'] or x.get('role')=='paragraph' or (x.name=='div' and (any(c in classes for c in ['html-p','para','paragraph']) or re.fullmatch(r'p\d+',x.get('id',''))))
        if is_para:
            if x.name=='div' and x.select_one('p,div.html-p,div.para,div[role="paragraph"]'):
                for child in x.children:walk(child)
            else:push(text_of(x))
            return
        for child in x.children:walk(child)
    walk(node)
    for s in sections:
        s['content']='\n\n'.join(s['paragraphs'])
        for sub in s['subsections']:sub['content']='\n\n'.join(sub['paragraphs'])
        s['subsections']=[x for x in s['subsections'] if x['paragraphs']]
    return [s for s in sections if s['paragraphs'] or s['subsections']]

def extract_refs(soup,name,url):
    selectors={'wiley':'.article-section__references li[data-bib-id]','mdpi':'#html-references_list li','bjr':'#article-body .ref-list p.reference','sage':'#bibliography .biblioentry','oup':'.widget-ArticleFulltext .ref-list .ref-content','frontiers':'ul.References > li.References__item','sd':'.references li','iop':'#references-wrapper .ref'}
    records=[];seen=set()
    for idx,r in enumerate(soup.select(selectors[platform(name)]),1):
        doi=pmid=''
        for a in r.select('a[href]'):
            href=a['href'];m=re.search(r'(?:dx\.)?doi\.org/(10\..+)',href,re.I)
            if m:doi=unquote(m.group(1))
            m=re.search(r'pubmed(?:\.ncbi\.nlm\.nih\.gov)?/(\d+)|pubmed\.ncbi\.nlm\.nih\.gov/(\d+)',href)
            if m:pmid=next(v for v in m.groups() if v)
        content=copy.deepcopy(r.select_one('.citation-content,.reference-mixed-citation,.mixed-citation,.References__content,.reference') or r)
        for link in content.select('.ReferenceLinks,.References__links'):link.decompose()
        text=text_of(content)
        text=re.sub(r'\s*(?:CAS|PubMed|Web of Science®?|Google Scholar|Find Full Text|CrossRef|Crossref)\s*',' ',text)
        identity=norm(text)
        if identity in seen:continue
        seen.add(identity)
        records.append({'index':len(records)+1,'text':identity,'sourceUrl':url,'href':'https://doi.org/'+doi if doi else '', 'doi':doi,'pmid':pmid,'pubmedFound':False})
    return records

def convert(name):
    source=INPUT_DIR/(name+'.mhtml')
    out=STAGE/name;out.mkdir(parents=True,exist_ok=True)
    url,html,assets=parse_mhtml(source)
    soup=BeautifulSoup(html,'html.parser');combined,body=roots(soup,name)
    expected=BY_NAME[name]
    def meta(label):
        x=soup.find('meta',attrs={'name':re.compile('^'+re.escape(label)+'$',re.I)})
        return x.get('content','').strip() if x else ''
    doi=meta('citation_doi') or expected['doi']
    assert doi.lower()==expected['doi'].lower(),(name,doi)
    title=BeautifulSoup(meta('citation_title') or expected['title'],'html.parser').get_text(' ',strip=True)
    authors=[x.get('content','') for x in soup.find_all('meta',attrs={'name':re.compile('^citation_author$',re.I)})]
    if not authors:
        authors=[norm(x.get('content','')) for x in soup.find_all('meta',attrs={'name':re.compile(r'^dc\.creator$',re.I)})]
    if not authors:
        if INVENTORY is None:raise ValueError(f'{name}: citation authors missing; provide --inventory for local Zotero metadata')
        inventory=INVENTORY
        item=next(i for i in inventory if i['fields'].get('DOI','').lower()==doi.lower())
        authors=[norm(x.get('firstName','')+' '+x.get('lastName','')) for x in item['creators'] if x.get('creatorType','author')=='author']
    figures,fw,details=extract_figures(combined,name,url,assets,out)
    tables,tw=extract_tables(combined,name)
    supplements=[]
    supplement=(SUPPLEMENT_DIR/name/'table1.user.html') if SUPPLEMENT_DIR else out/'no-supplement.html'
    if name=='Breuil2021' and supplement.exists():
        table=BeautifulSoup(supplement.read_text(encoding='utf-8'),'html.parser').find('table')
        assert table is not None
        assert len(table.select('tbody > tr'))==8
        assert all(len(r.find_all('td',recursive=False))==8 for r in table.select('tbody > tr'))
        for li in list(table.select('li')):li.insert_after('; ')
        table_content='Table 1. Oxytocin and bone: human studies on oxytocin.\n\n'+table_markdown(table)
        tables=[t for t in tables if t['title']!='Table 1']+[section('Table 1','table',[table_content])]
        tw=[w for w in tw if not w.startswith('Table body not embedded: Table 1.')]
        supplements.append({'file':'Breuil2021.table1.user.html','source':'user-provided publisher table HTML','sha256':hashlib.sha256(supplement.read_bytes()).hexdigest(),'dataRows':8,'columns':8})
    sections=extract_body(combined)
    idx=next((i+1 for i,s in enumerate(sections) if s['type']=='abstract'),0)
    sections[idx:idx]=figures
    sections.extend(tables)
    count=sum(len(s['paragraphs'])+sum(len(x['paragraphs']) for x in s['subsections']) for s in sections if s['type']!='figure')
    article={'id':name,'sourceUrl':url,'title':title,'authors':authors,'journal':meta('citation_journal_title'),'year':(re.search(r'(?:19|20)\d{2}',meta('citation_publication_date') or meta('citation_date') or name).group()),'doi':doi,'createdAt':NOW,'sections':sections,'chunkCount':count,'extractionSource':'local-mhtml-offline','qualityWarnings':fw+tw,'provenance':{'mhtmlFile':name+'.mhtml','sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'networkUsed':False}}
    if supplements:article['provenance']['supplements']=supplements
    refs=extract_refs(soup,name,url)
    if not refs:
        article['qualityWarnings'].append('Reference list not embedded in saved MHTML')
    if name=='Tamma2009' and len(refs)==3:
        article['qualityWarnings'].append('Reference list partially embedded: only references 1–3 are present')
    references={'id':name,'sourceUrl':url,'title':title,'doi':doi,'createdAt':NOW,'totalReferences':len(refs),'pubmedFound':0,'abstractFound':0,'records':refs,'extractionSource':'local-mhtml-offline'}
    (out/'article.json').write_text(json.dumps(article,ensure_ascii=False,indent=2),encoding='utf-8')
    (out/'reference.json').write_text(json.dumps(references,ensure_ascii=False,indent=2),encoding='utf-8')
    (out/'source.html').write_text(html,encoding='utf-8')
    fulltext=[s for s in sections if s['type'] not in ['abstract','figure','table']]
    assert len(fulltext)>=3 and count>=15,(name,'insufficient body')
    assert not any('\ufffd' in s['content'] for s in fulltext),(name,'encoding error')
    result={'id':name,'doi':doi,'source':str(source),'sha256':article['provenance']['sha256'],'textParagraphs':count,'figures':len(figures),'embeddedFigures':len(details),'tables':len(tables),'references':len(refs),'warnings':article['qualityWarnings'],'figureDetails':details,'sectionTitles':[s['title'] for s in fulltext]}
    (out/'audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    return result

def main():
    global STAGE, INPUT_DIR, SUPPLEMENT_DIR, INVENTORY, BY_NAME
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('names', nargs='+', help='Article IDs, matching <ID>.mhtml and manifest filenames')
    parser.add_argument('--input-dir', type=Path, required=True, help='Directory containing saved MHTML archives')
    parser.add_argument('--output-dir', type=Path, required=True, help='Staging directory; existing article folders are refused')
    parser.add_argument('--manifest', type=Path, required=True, help='JSON list with filename, doi and title for each article')
    parser.add_argument('--inventory', type=Path, help='Optional local Zotero metadata JSON list (fields.DOI and creators)')
    parser.add_argument('--supplement-dir', type=Path, help='Optional local supplements: <ID>/table1.user.html for Breuil2021')
    args=parser.parse_args()
    STAGE=args.output_dir.resolve();INPUT_DIR=args.input_dir.resolve()
    SUPPLEMENT_DIR=args.supplement_dir.resolve() if args.supplement_dir else None
    INVENTORY=json.loads(args.inventory.read_text(encoding='utf-8-sig')) if args.inventory else None
    manifest=json.loads(args.manifest.read_text(encoding='utf-8-sig'))
    BY_NAME={Path(x['filename']).stem:x for x in manifest}
    names=list(dict.fromkeys(args.names))
    for name in names:
        if not re.fullmatch(r'[A-Za-z0-9_-]+',name):parser.error(f'Invalid article ID: {name}')
        if name not in BY_NAME:parser.error(f'Article absent from manifest: {name}')
        if not any(name in group for group in PLATFORMS.values()):parser.error(f'Unsupported publisher layout for ID: {name}')
        if not (INPUT_DIR/(name+'.mhtml')).is_file():parser.error(f'Missing archive: {name}.mhtml')
        if (STAGE/name).exists():parser.error(f'Output already exists: {STAGE/name}; choose a new staging directory')
    results=[convert(name) for name in names]
    (STAGE/'batch-audit.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
    for result in results:
        print(json.dumps({k:v for k,v in result.items() if k not in ['figureDetails','source','sha256']},ensure_ascii=False))

if __name__=='__main__':
    main()
