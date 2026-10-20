"""Portable display rules; explicitly pinned private audits grant no publication authority."""
import ast
import hashlib
import importlib.util
import json
import re
import os
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
ROOT=next(p for p in Path(__file__).resolve().parents if (p/'package.json').is_file())
REAL_AUDIT=os.environ.get('PD_SOURCE_FIGURE_CAPTION_REAL_AUDIT')
REAL_AUDIT_SHA=os.environ.get('PD_SOURCE_FIGURE_CAPTION_REAL_AUDIT_SHA256')
HUGO_AUDIT=os.environ.get('PD_SOURCE_FIGURE_CAPTION_HUGO_REAL_AUDIT')
HUGO_AUDIT_SHA=os.environ.get('PD_SOURCE_FIGURE_CAPTION_HUGO_REAL_AUDIT_SHA256')
sys.path.insert(0,str(ROOT/'scripts'))
sys.path.insert(0,str(ROOT/'manual/scripts'))
filename=ROOT/'scripts/publish_common.py'
spec=importlib.util.spec_from_file_location('caption_publish_common_proposal',filename)
common=importlib.util.module_from_spec(spec);spec.loader.exec_module(common)
from markdown_hugo_gate import parse_frontmatter_content,validate_markdown_format_gate
# Execute the genuine conference final display repair in memory, never replace
# its implementation or feed a synthetic packet into a qualified source path.
tree=ast.parse((ROOT/'scripts/conference-page-render.py').read_text());names={'repair_caption_quoted_gloss_links','repair_reader_figure_caption_emphasis','repair_formula_delimiters'}
namespace={'re':re}
for node in tree.body:
    if isinstance(node,ast.FunctionDef) and node.name in names:
        exec(compile(ast.Module(body=[node],type_ignores=[]),'<actual conference repair>', 'exec'),namespace)
repair=namespace['repair_formula_delimiters']
URL='https://example.org/source$literal.png'

def read_pinned(record):
    if not isinstance(record,dict) or set(record)!={'path','sha256'} \
            or not isinstance(record['path'],str) or not Path(record['path']).is_absolute() \
            or not re.fullmatch('[a-f0-9]{64}',str(record['sha256'] or '')):
        raise ValueError('真实审计输入须有绝对路径和精确原字节SHA')
    path=Path(record['path'])
    fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0))
    try:
        before=os.fstat(fd);named=path.lstat()
        if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or path.is_symlink() \
                or (before.st_dev,before.st_ino)!=(named.st_dev,named.st_ino) or before.st_size>32*1024*1024:
            raise ValueError('真实审计输入不是唯一普通有界文件')
        with os.fdopen(fd,'rb',closefd=False) as handle: raw=handle.read(32*1024*1024+1)
        after=os.fstat(fd);final=path.lstat()
        keys=('st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns','st_nlink')
        if any(tuple(getattr(info,key) for key in keys)!=tuple(getattr(before,key) for key in keys)
               for info in (after,final)) or hashlib.sha256(raw).hexdigest()!=record['sha256']:
            raise ValueError('真实审计原文件SHA或读取身份已变化')
        return raw
    finally: os.close(fd)

def audit_manifest(filename,sha,contract):
    value=json.loads(read_pinned({'path':filename,'sha256':sha}))
    if not isinstance(value,dict) or value.get('contract')!=contract:
        raise ValueError('真实审计清单合同无效')
    return value

def real_caption_case(filename,sha,role,failure_name):
    manifest=audit_manifest(filename,sha,'source-figure-caption-real-audit-v1')
    case=(manifest.get('cases') or {}).get(role)
    if not isinstance(case,dict) or set(case)!={'failure','markdown'}:
        raise ValueError('真实审计清单缺少完整原拒稿及原Markdown，不能改选当前稿')
    if Path(case['failure']['path']).name!=failure_name+'.json':
        raise ValueError('真实审计必须绑定指定的原失败记录')
    failure=json.loads(read_pinned(case['failure']));raw=read_pinned(case['markdown'])
    if failure.get('sha256')!=case['markdown']['sha256']:
        raise ValueError('真实拒稿记录与原Markdown的SHA不一致')
    return Path(case['markdown']['path']),raw,failure

def real_hugo_audit():
    manifest=audit_manifest(HUGO_AUDIT,HUGO_AUDIT_SHA,'source-figure-caption-hugo-audit-v1')
    root=Path(manifest.get('root',''))
    files=manifest.get('files')
    if not root.is_absolute() or not root.is_dir() or not isinstance(files,dict) or not files:
        raise ValueError('真实Hugo审计须绑定独立完整目录及逐文件SHA')
    actual={p.relative_to(root).as_posix() for p in root.rglob('*') if not p.is_dir()}
    if actual!=set(files):raise ValueError('真实Hugo审计目录文件集合已变化')
    for relative,digest in files.items():
        if Path(relative).is_absolute() or '..' in Path(relative).parts:
            raise ValueError('真实Hugo审计目录路径无效')
        read_pinned({'path':str(root/relative),'sha256':digest})
    generation=json.loads(read_pinned(manifest.get('generation')))
    return root,generation

def pair(value,alt=None):
    alt=alt if alt is not None else value
    return f'[![原论文 Figure 2：{alt}]({URL})]({URL})\n\n*论文图 7。原论文 Figure 2：“{value}”。*\n'

class ExplicitPrivateAuditInputTests(unittest.TestCase):
    def record(self,path):
        return {'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}

    def fixture(self,root):
        # Synthetic metadata only: this does not claim a real source or pass.
        markdown=root/'synthetic-original.md';markdown.write_text('synthetic original fixture')
        name='a'*64;failure=root/(name+'.json')
        failure.write_text(json.dumps({'path':'content/posts/synthetic.md','sha256':self.record(markdown)['sha256']}))
        manifest=root/'audit.json';manifest.write_text(json.dumps({
            'contract':'source-figure-caption-real-audit-v1',
            'cases':{'synthetic':{'failure':self.record(failure),'markdown':self.record(markdown)}}}))
        return manifest,markdown,failure,name

    def test_exact_original_case_is_independent_of_active_runtime_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest,markdown,_failure,name=self.fixture(Path(directory))
            p,raw,failure=real_caption_case(str(manifest),self.record(manifest)['sha256'],'synthetic',name)
            self.assertEqual(p,markdown);self.assertEqual(raw,b'synthetic original fixture')
            self.assertEqual(hashlib.sha256(raw).hexdigest(),failure['sha256'])
            self.assertEqual(markdown.read_bytes(),raw)

    def test_opted_in_missing_case_bad_manifest_or_changed_original_fails_never_skips(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest,markdown,_failure,name=self.fixture(Path(directory));pin=self.record(manifest)['sha256']
            for role,digest in [('missing',pin),('synthetic','0'*64),('synthetic',None)]:
                with self.subTest(role=role,digest=digest),self.assertRaises(ValueError):
                    real_caption_case(str(manifest),digest,role,name)
            markdown.write_text('a newer draft must not replace the original')
            with self.assertRaisesRegex(ValueError,'SHA'):
                real_caption_case(str(manifest),pin,'synthetic',name)

    def test_wrong_original_failure_or_markdown_sha_cannot_retarget_case(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest,_markdown,failure,name=self.fixture(Path(directory))
            with self.assertRaisesRegex(ValueError,'指定的原失败'):
                real_caption_case(str(manifest),self.record(manifest)['sha256'],'synthetic','b'*64)
            failure.write_text(json.dumps({'path':'content/posts/synthetic.md','sha256':'0'*64}))
            value=json.loads(manifest.read_text());value['cases']['synthetic']['failure']=self.record(failure)
            manifest.write_text(json.dumps(value))
            with self.assertRaisesRegex(ValueError,'原Markdown'):
                real_caption_case(str(manifest),self.record(manifest)['sha256'],'synthetic',name)

class SourceFigureCaptionLiteralDollarTests(unittest.TestCase):
    def test_literal_corruption_is_escaped_without_guessing_metric(self):
        for value in ['C##$ values','Results (C$$%)','C$$$$% literal']:
            text=pair(value);after=common.escape_literal_source_figure_caption_dollars(text)
            self.assertEqual(after.replace(r'\$','$'),text)
            self.assertEqual(after.count(URL),2)
            self.assertEqual(common.escape_literal_source_figure_caption_dollars(after),after)
            self.assertIn(value.replace('$',r'\$'),after)
    def test_real_math_and_existing_escapes_are_preserved_by_helper(self):
        for value in [r'value $x+1$ and $$E=mc^2$$',r'value $$ E=mc^2 $$',r'\(C_{llr}\) and \[x+y\]',r'literal C\$ and C\$\$%']:
            text=pair(value);self.assertEqual(common.escape_literal_source_figure_caption_dollars(text),text)
    def test_code_fences_inline_code_urls_and_non_source_caption_unchanged(self):
        for value in ['```text\n'+pair('C$$%')+'```\n','`source example\n'+pair('C$$%')+'`\n','~~~\n'+pair('C##$')+'~~~\n','```\n'+pair('C##$'),
                      pair('`C$$%`'),pair('https://example.org/C$$%'),
                      '正文 C##$ 与 C$$% 不属于来源图注。\n',
                      '*论文图 7。原论文 Figure 2：“C##$”。*\n',
                      pair('C$$%').replace('论文图','普通图')]:
            self.assertEqual(common.escape_literal_source_figure_caption_dollars(value),value)
    def test_wrong_label_wrapper_or_nonadjacent_node_not_rewritten(self):
        for value in [pair('C##$').replace('原论文 Figure 2：“','原论文 Figure 3：“'),
                      pair('C##$').replace(')]('+URL+')',')](https://example.net/other)'),
                      pair('C##$').replace('\n\n*论文图','\n\n正文说明。\n\n*论文图')]:
            self.assertEqual(common.escape_literal_source_figure_caption_dollars(value),value)
    def test_only_one_same_native_figure_source_note_may_separate_image_caption(self):
        for note in ['原论文 PDF 第 2 页 Figure 2（出版显示裁切）','原论文 PDF 第 2 页，本文讨论 Figure 2（完整原页）','原论文 PDF 第 2 页，本文讨论 Figure 2（完整原页；图注未完整抽取，以原页为准）']:
            line='> **图片来源：** '+note+'。\n\n'
            text=pair('C$$%').replace('\n\n*论文图','\n\n'+line+'*论文图')
            after=common.escape_literal_source_figure_caption_dollars(text)
            self.assertEqual(after.replace(r'\$','$'),text)
            self.assertNotEqual(after,text)
            for bad in [line.replace('Figure 2','Figure 3'),line+line,line.replace('> **图片来源：**','图片来源：'),line+'正文说明。\n\n']:
                invalid=pair('C$$%').replace('\n\n*论文图','\n\n'+bad+'*论文图')
                self.assertEqual(common.escape_literal_source_figure_caption_dollars(invalid),invalid)

    @unittest.skipUnless(REAL_AUDIT,'explicit SHA-bound private caption audit opt-in')
    def test_real_louro_body_currency_dollars_remain_outside_caption_permission(self):
        p,raw,failure=real_caption_case(REAL_AUDIT,REAL_AUDIT_SHA,'louro-body',
            'fe6bf534f56f8337461a2cd8a43850a62c39bdad604106ea85191711369907c3')
        self.assertEqual(hashlib.sha256(raw).hexdigest(),failure['sha256'])
        text=raw.decode();self.assertIn('原文 $50 与 $100 的写法',text)
        out=common.escape_literal_source_figure_caption_dollars(text)
        self.assertEqual(out,text)
        fm,body=parse_frontmatter_content(p,out)
        self.assertTrue(any('裸 $' in issue for issue in validate_markdown_format_gate(p,fm,body)))
        self.assertEqual(p.read_bytes(),raw)

    def test_slash_parity_and_existing_escape_idempotence(self):
        text=pair(r'C\$ C\\$ C\\\$')
        after=common.escape_literal_source_figure_caption_dollars(text)
        self.assertIn(r'C\$ C\\\$ C\\\$',after)
        self.assertEqual(common.escape_literal_source_figure_caption_dollars(after),after)
    def test_body_math_uses_existing_normal_converter(self):
        body=r'正常 $x+1$ 以及 \(y+1\) 与 \[z+1\]；代码 `$literal$`。'
        before=common.escape_literal_source_figure_caption_dollars(body)
        self.assertEqual(before,body)
        after=common.sanitize_markdown_for_publish(body)
        self.assertIn(r'\(x+1\)',after);self.assertIn(r'\(y+1\)',after);self.assertIn(r'\[z+1\]',after)
        self.assertIn('`$literal$`',after)
    def test_shared_then_conference_repair_does_not_unescape_literal_dollars(self):
        text=pair('C##$ and C$$%')
        shared=common.sanitize_markdown_for_publish(text)
        repaired=repair(shared)
        self.assertIn(r'C##\$',repaired);self.assertIn(r'C\$\$%',repaired)
        self.assertEqual(repair(repaired),repaired)
    @unittest.skipUnless(REAL_AUDIT,'explicit SHA-bound private caption audit opt-in')
    def test_both_real_saved_rejections_pass_normal_markdown_gate_after_display_repair(self):
        names=['bf761176d70256cb7598795a1226e0d8321d07a53eed4881277f93667a0963a1',
               '92b97c0fe946cf7b4e053f83715c1fef59f660b8b00a53cdf55d94699c13e3fa']
        done=0
        for index,name in enumerate(names):
            p,raw,failure=real_caption_case(REAL_AUDIT,REAL_AUDIT_SHA,f'caption-rejection-{index+1}',name)
            self.assertEqual(hashlib.sha256(raw).hexdigest(),failure['sha256'])
            text=raw.decode();fm,body=parse_frontmatter_content(p,text)
            before=validate_markdown_format_gate(p,fm,body);self.assertTrue(any('裸 $' in i for i in before))
            out=common.sanitize_markdown_for_publish(text);fm2,body2=parse_frontmatter_content(p,out)
            self.assertEqual(validate_markdown_format_gate(p,fm2,body2),[])
            self.assertEqual(validate_markdown_format_gate(p,fm2,repair(body2)),[])
            # The narrow new helper only adds escapes to source-caption/alt
            # fragments, preserving all scientific statements/signature fields.
            narrow=common.escape_literal_source_figure_caption_dollars(text)
            self.assertEqual(narrow.replace(r'\$','$'),text)
            self.assertEqual(p.read_bytes(),raw);done+=1
        self.assertEqual(done,2)

def load_gate(name, filename):
    spec=importlib.util.spec_from_file_location(name,filename)
    module=importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules,{'publish_common':common}):
        spec.loader.exec_module(module)
    return module
shared_gate=load_gate('caption_dollar_gate_proposal',ROOT/'scripts/markdown_hugo_gate.py')
conference_gate=load_gate('caption_dollar_conference_gate_proposal',ROOT/'scripts/conference_publication_gate.py')

class SourceBoundCaptionHtmlMaskTests(unittest.TestCase):
    def setUp(self):
        self.url='https://example.org/figure.png'
        self.source=common.escape_literal_source_figure_caption_dollars(pair('C$$%').replace(URL,self.url))
        self.caption='论文图 7。原论文 Figure 2：“C$$%”。'
        self.alt='原论文 Figure 2：C$$%'
        self.rendered=f'<p><a href="{self.url}"><img src="{self.url}" alt="{self.alt}" loading="lazy"></a></p>\n<p><em>{self.caption}</em></p>'
    def mask(self,html=None,source=None):
        return shared_gate.mask_source_bound_figure_caption_dollars(
            self.rendered if html is None else html,{'body':self.source if source is None else source})
    def test_exact_escaped_source_pair_only_changes_diagnostic_dollar_positions(self):
        original=self.rendered;masked=self.mask()
        self.assertNotEqual(masked,original);self.assertEqual(self.rendered,original)
        self.assertEqual(len(masked),len(original))
        self.assertTrue(all(a==b or (a=='$' and b=='X') for a,b in zip(original,masked)))
        self.assertEqual(shared_gate.math_and_emphasis_issues(masked,'HTML',rendered_html=True),[])
    def test_unescaped_or_mismatched_source_html_link_alt_and_unclosed_elements_rejected(self):
        for source in [pair('C$$%').replace(URL,self.url),self.source.replace('C\\$\\$%','D\\$\\$%'),
                       '*论文图 7。原论文 Figure 2：“C\\$\\$%”。*\n']:
            self.assertEqual(self.mask(source=source),self.rendered)
        for rendered in [self.rendered.replace(self.caption,self.caption+'wrong'),
                         self.rendered.replace('alt="'+self.alt+'"','alt="wrong '+self.alt+'"'),
                         self.rendered.replace('href="'+self.url+'"','href="https://example.org/other.png"'),
                         self.rendered.replace('src="'+self.url+'"','src="https://example.org/other.png"'),
                         self.rendered.replace('alt="'+self.alt+'"','alt="'+self.alt+'" alt="'+self.alt+'"'),
                         self.rendered.replace('</em>',''),self.rendered.replace('<em>','<em><!--altered-->'),
                         '<pre><code>'+self.rendered+'</code></pre>', self.rendered+self.rendered]:
            self.assertEqual(self.mask(html=rendered),rendered)
            self.assertTrue(shared_gate.math_and_emphasis_issues(rendered,'HTML',rendered_html=True))
    def test_exact_source_note_dom_required_and_no_arbitrary_prose_bridge(self):
        for note in ['原论文 PDF 第 2 页 Figure 2（出版显示裁切）','原论文 PDF 第 2 页，本文讨论 Figure 2（完整原页）','原论文 PDF 第 2 页，本文讨论 Figure 2（完整原页；图注未完整抽取，以原页为准）']:
            source=self.source.replace('\n\n*论文图','\n\n> **图片来源：** '+note+'。\n\n*论文图')
            block='<blockquote><p><strong>图片来源：</strong> '+note+'。</p></blockquote>\n'
            rendered=self.rendered.replace('<p><em>',block+'<p><em>')
            masked=self.mask(html=rendered,source=source)
            self.assertNotEqual(masked,rendered)
            self.assertEqual(shared_gate.math_and_emphasis_issues(masked,'HTML',rendered_html=True),[])
            for bad in [rendered.replace('第 2 页','第 3 页'),rendered.replace('Figure 2（','Figure 3（'),rendered.replace('<strong>图片来源：</strong>','图片来源：'),rendered.replace('</blockquote>','</blockquote>'+block),rendered.replace(block,'<p>说明。</p>')]:
                self.assertEqual(self.mask(html=bad,source=source),bad)
            self.assertEqual(self.mask(html=rendered,source=self.source),rendered)

    def test_same_text_outside_bound_caption_and_real_body_dollars_never_borrow_mask(self):
        for extra in ['<p><em>'+self.caption+'</em></p>','<p>'+self.alt+'</p>','<p>$x+1$</p>','<p>C$$% body</p>']:
            rendered=self.rendered+extra;masked=self.mask(html=rendered)
            self.assertTrue(masked.endswith(extra))
            self.assertTrue(shared_gate.math_and_emphasis_issues(masked,'HTML',rendered_html=True))
    def test_changed_url_attribute_literal_dollars_not_masked_as_alt(self):
        rendered=self.rendered.replace('loading="lazy"','title="C$$%"')
        masked=self.mask(html=rendered)
        self.assertIn('title="C$$%"',masked)
        self.assertTrue(shared_gate.math_and_emphasis_issues(masked,'HTML',rendered_html=True))
    @unittest.skipUnless(HUGO_AUDIT,'explicit SHA-bound private Hugo audit opt-in')
    def test_real_hugo_outputs_pass_both_normal_shared_and_conference_gates(self):
        O,generation=real_hugo_audit()
        self.assertTrue((O/'native-goldmark-two-page-rendered').is_dir())
        cases=[]
        for d in (O/'display-projections-only').glob('ishihara*'):
            evidence=json.loads((d/'evidence.json').read_text());md=(d/'normal-sanitized-display-only.md').read_text()
            fm,body=shared_gate.parse_frontmatter_content('page.md',md)
            candidates=shared_gate.rendered_page_candidates(O/'native-goldmark-two-page-rendered',fm['title'],evidence['generationRecord']['path'])
            self.assertEqual(len(candidates),1);path,rendered=candidates[0];original=path.read_bytes()
            fragment=shared_gate.rendered_article_fragment(rendered)
            self.assertTrue(shared_gate.math_and_emphasis_issues(fragment,'real Hugo',rendered_html=True))
            with patch.dict(sys.modules,{'markdown_hugo_gate':shared_gate}):
                result=conference_gate.inspect_html(md,rendered,[a for a in generation['imageFiles'] if a['paperId']==evidence['generationRecord']['paperId']],
                    'https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main')
            self.assertEqual(result['layers']['htmlMechanical'],'passed')
            self.assertEqual(path.read_bytes(),original)
            cases.append({'path':evidence['generationRecord']['path'],'body':body,'frontmatter':fm})
        self.assertEqual(len(cases),2)
        self.assertEqual(shared_gate.validate_hugo_rendered_html_gate(O/'native-goldmark-two-page-rendered',cases),[])

    @unittest.skipUnless(HUGO_AUDIT,'explicit SHA-bound private Hugo audit opt-in')
    def test_real_hugo_note_structure_fixtures_pass_without_losing_native_caption(self):
        O,g=real_hugo_audit()
        self.assertTrue((O/'native-goldmark-two-page-noted-rendered').is_dir())
        artifacts=[]
        for d in (O/'display-projections-only').glob('ishihara*'):
            e=json.loads((d/'evidence.json').read_text());p=O/'native-goldmark-two-page-noted-copy'/e['generationRecord']['path'];md=p.read_text()
            fm,body=shared_gate.parse_frontmatter_content(p,md)
            self.assertIn('> **图片来源：** 原论文 PDF 第 2 页，本文讨论 Figure',body)
            candidates=shared_gate.rendered_page_candidates(O/'native-goldmark-two-page-noted-rendered',fm['title'],e['generationRecord']['path']);self.assertEqual(len(candidates),1)
            htmlpath,html=candidates[0];before=htmlpath.read_bytes()
            with patch.dict(sys.modules,{'markdown_hugo_gate':shared_gate}):
                result=conference_gate.inspect_html(md,html,[a for a in g['imageFiles'] if a['paperId']==e['paperId']],
                    'https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main')
            self.assertEqual(result['layers']['htmlMechanical'],'passed');self.assertEqual(htmlpath.read_bytes(),before)
            self.assertEqual(validate_markdown_format_gate(p,fm,body),[])
            artifacts.append({'path':e['generationRecord']['path'],'body':body,'frontmatter':fm})
        self.assertEqual(len(artifacts),2)
        self.assertEqual(shared_gate.validate_hugo_rendered_html_gate(O/'native-goldmark-two-page-noted-rendered',artifacts),[])

    @unittest.skipUnless(HUGO_AUDIT,'explicit SHA-bound private Hugo audit opt-in')
    def test_real_hugo_limited_note_structure_fixtures_pass_without_losing_native_caption(self):
        O,g=real_hugo_audit()
        self.assertTrue((O/'native-goldmark-two-page-limited-noted-rendered').is_dir())
        artifacts=[]
        for d in (O/'display-projections-only').glob('ishihara*'):
            e=json.loads((d/'evidence.json').read_text());p=O/'native-goldmark-two-page-limited-noted-copy'/e['generationRecord']['path'];md=p.read_text()
            fm,body=shared_gate.parse_frontmatter_content(p,md)
            self.assertIn('> **图片来源：** 原论文 PDF 第 2 页，本文讨论 Figure',body)
            self.assertIn('（完整原页；图注未完整抽取，以原页为准）',body)
            candidates=shared_gate.rendered_page_candidates(O/'native-goldmark-two-page-limited-noted-rendered',fm['title'],e['generationRecord']['path']);self.assertEqual(len(candidates),1)
            htmlpath,html=candidates[0];before=htmlpath.read_bytes()
            with patch.dict(sys.modules,{'markdown_hugo_gate':shared_gate}):
                result=conference_gate.inspect_html(md,html,[a for a in g['imageFiles'] if a['paperId']==e['paperId']],
                    'https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main')
            self.assertEqual(result['layers']['htmlMechanical'],'passed');self.assertEqual(htmlpath.read_bytes(),before)
            self.assertEqual(validate_markdown_format_gate(p,fm,body),[])
            artifacts.append({'path':e['generationRecord']['path'],'body':body,'frontmatter':fm})
        self.assertEqual(len(artifacts),2)
        self.assertEqual(shared_gate.validate_hugo_rendered_html_gate(O/'native-goldmark-two-page-limited-noted-rendered',artifacts),[])

class ClosedCodeMathGateTests(unittest.TestCase):
    def test_closed_commonmark_inline_code_preserves_literal_currency_and_delimiters(self):
        for value in ['`$50`',r'`**unfinished \(`','``a ` $50``','`line\n$50`',r'\\`$50`']:
            self.assertEqual(shared_gate.math_and_emphasis_issues(value,'code'),[])
            masked=shared_gate.mask_closed_code_for_format_gate(value)
            self.assertEqual(len(masked),len(value))
        self.assertTrue(shared_gate.math_and_emphasis_issues('`$50` $100','code'))
    def test_unclosed_mismatched_escaped_openers_and_outside_symbols_still_rejected(self):
        for value in ['`$50','``$50`','`$50``',r'\`$50`','`first\n\n$50`','$50 `ok`','`ok` **broken',r'`ok` \(']:
            self.assertTrue(shared_gate.math_and_emphasis_issues(value,'code'),value)
    def test_only_real_properly_closed_html_code_or_pre_nodes_are_masked(self):
        for value in ['<code>$50</code>','<pre><code>$50 ** \\(</code></pre>',
                      '<article><!-- outside --><p><code>$50</code></p></article>']:
            before=value;self.assertEqual(shared_gate.math_and_emphasis_issues(value,'HTML',rendered_html=True),[])
            self.assertEqual(value,before)
        for value in ['<code>$50','<pre>$50','<code>$50</pre>','<code/>$50',
                      '&lt;code&gt;$50&lt;/code&gt;','<code>$50</code> $100',
                      '<pre><code>$50</pre>','<script><code>$50</code></script>',
                      '<svg><code>$50</code></svg>','<math><code>$50</code></math>',
                      '<code x="a" x="b">$50</code>','<p title="<code>$50</code>">$100</p>']:
            self.assertTrue(shared_gate.math_and_emphasis_issues(value,'HTML',rendered_html=True),value)

    @unittest.skipUnless(HUGO_AUDIT,'explicit SHA-bound private Hugo audit opt-in')
    def test_real_louro_inline_projection_and_actual_hugo_pass_shared_and_conference_format_gates(self):
        O,g=real_hugo_audit()
        self.assertTrue((O/'native-goldmark-louro-inline-rendered').is_dir())
        evidence=json.loads((O/'louro26-body-currency-readonly.json').read_text())
        p=O/'native-goldmark-louro-inline-copy'/evidence['generationRecord']['path'];md=p.read_text()
        self.assertIn('原文 `$50` 与 `$100`',md)
        fm,body=shared_gate.parse_frontmatter_content(p,md);self.assertEqual(validate_markdown_format_gate(p,fm,body),[])
        candidates=shared_gate.rendered_page_candidates(O/'native-goldmark-louro-inline-rendered',fm['title'],evidence['generationRecord']['path']);self.assertEqual(len(candidates),1)
        htmlpath,rendered=candidates[0];original=htmlpath.read_bytes()
        self.assertIn('<code>$50</code>',rendered);self.assertIn('<code>$100</code>',rendered)
        with patch.dict(sys.modules,{'markdown_hugo_gate':shared_gate}):
            result=conference_gate.inspect_html(md,rendered,[a for a in g['imageFiles'] if a['paperId']==evidence['generationRecord']['paperId']],
                'https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main')
        self.assertEqual(result['layers']['htmlMechanical'],'passed')
        self.assertEqual(shared_gate.validate_hugo_rendered_html_gate(O/'native-goldmark-louro-inline-rendered',
            [{'path':evidence['generationRecord']['path'],'body':body,'frontmatter':fm}]),[])
        self.assertEqual(htmlpath.read_bytes(),original)
        # Actual original plain-dollar source remains rejected: code is not a
        # global currency exemption and no source/scientific pass is granted.
        manifest=audit_manifest(HUGO_AUDIT,HUGO_AUDIT_SHA,'source-figure-caption-hugo-audit-v1')
        original=manifest.get('louroOriginalMarkdown')
        if not isinstance(original,dict) or original.get('sha256')!=evidence['generationRecord']['sourceSha256']:
            raise ValueError('真实Louro审计缺少原稿的精确SHA绑定，不能改读当前来源路径')
        original_md=read_pinned(original).decode();fm0,body0=shared_gate.parse_frontmatter_content(p,original_md)
        self.assertTrue(any('裸 $' in issue for issue in validate_markdown_format_gate(p,fm0,body0)))

if __name__=='__main__':unittest.main(verbosity=2)
