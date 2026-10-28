# Fixed read-only child for the Node tmp-write-guard test. FD 3 is its only input.
import sys,os,json,hashlib,gzip,re,types,copy
sys.dont_write_bytecode=True

def readonly(event,args):
    if event.startswith('socket.') or event in {'subprocess.Popen','os.system','os.exec','os.posix_spawn','os.remove','os.rename','os.mkdir','os.chmod','os.rmdir','os.truncate'}:
        raise RuntimeError('READONLY_PARITY_GUARD: '+event)
    if event=='open':
        mode=args[1];flags=args[2]
        if isinstance(mode,str) and any(c in mode for c in 'wax+') or isinstance(flags,int) and flags&(os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC|os.O_APPEND):
            raise RuntimeError('READONLY_PARITY_GUARD: write open')
sys.addaudithook(readonly)
from pathlib import Path
payload=json.loads(os.read(3,4*1024*1024))
root=Path(payload['root']);sys.path[:0]=[str(root/'scripts'),str(root/'manual/scripts')]
raw=Path(payload['fixtureFile']).read_bytes();sha=lambda x:hashlib.sha256(x).hexdigest()
assert sha(raw)==payload['fixtureSha256']
fixture=json.loads(gzip.decompress(raw));assert fixture['notGrant'] and fixture['adoptionAuthorized'] is False
module_path=Path(payload.get('moduleFile') or root/'scripts/publish_common.py')
source=module_path.read_bytes();assert sha(source)==payload['moduleSha256']
m=types.ModuleType('publish_common_parity');m.__file__=str(root/'scripts/publish_common.py');exec(compile(source,str(module_path),'exec'),m.__dict__)
checks=[]
def check(name,ok):
    if not ok:raise AssertionError(name)
    checks.append(name)
def table(r,index=0):return m.extract_markdown_tables(m._extract_analysis_section(r['analysis'],'实验结果'))[index]
def validate(r,analysis=None,source=None):return m.validate_experiment_table_contract(r['analysis'] if analysis is None else analysis,contract_version=r['tableContract'],document_type=r['documentType'],source_text=r['sourceText'] if source is None else source)
a,b=fixture['records'];assert a['arxivId'].startswith('2610.32310') and b['arxivId'].startswith('2610.34477')
for r in (a,b):
    check(r['arxivId']+' raw analysis SHA',sha(r['analysis'].encode())==r['analysisSha256']);check(r['arxivId']+' raw source SHA',sha(r['sourceText'].encode())==r['sourceSha256']);check(r['arxivId']+' real unchanged whole contract',validate(r) is None)
ta,sa=table(a),a['sourceText'];claim=re.search(r'^To isolate the contributions[^\n]+$',sa,re.M)[0];caption=re.search(r'^Table 1: Overview of model variants[^\n]+$',sa,re.M)[0]
check('loss real columns',m._source_bound_loss_switch_columns(ta,sa)=={1,2,3})
for alias in ['损失归一化','waveform-loss normalization']:
    t=copy.deepcopy(ta);t['header'][2]=alias;check('loss exact alias '+alias,m._source_bound_loss_switch_columns(t,sa)=={1,2,3})
for header in ['准确率','准确率损失','SDR','波形损失归一化准确率','损失归一化得分']:
    t=copy.deepcopy(ta);t['header'][2]=header;check('reject metric pseudo switch '+header,not m._source_bound_loss_switch_columns(t,sa))
for mutate in [lambda t:t['rows'].pop(),lambda t:t['rows'].append(t['rows'][0]),lambda t:t['rows'].reverse(),lambda t:t['rows'].__setitem__(2,t['rows'][1]),lambda t:t['rows'][2].__setitem__(0,'Unknown'),lambda t:t['rows'][2].__setitem__(2,'是'),lambda t:t['rows'][2].__setitem__(2,'1')]:
    t=copy.deepcopy(ta);mutate(t);check('reject incomplete/misaligned loss table '+str(len(checks)),not m._source_bound_loss_switch_columns(t,sa))
for replacement in ['If '+claim,claim.replace('are trained and evaluated','would hypothetically be trained and evaluated'),claim.replace('are trained and evaluated','are not trained and evaluated'),'Previous work.\n'+claim,'Related study.\n'+claim,'External work.\n'+claim,'Third-party study.\n'+claim,'> '+claim,'“'+claim+'”','```text\n'+claim]:
    check('reject loss source claim '+str(len(checks)),not m._source_bound_loss_switch_columns(ta,sa.replace(claim,replacement)))
for notice in [', but this procedure was not implemented','. This was never implemented.','. This was never actually implemented.','. We did not implement this procedure.',' We did not actually train or evaluate these variants.',' We do not actually evaluate these variants.','. This experiment was withdrawn.']:
    for anchor in [claim,caption]:check('reject loss adjacent revocation '+str(len(checks)),not m._source_bound_loss_switch_columns(ta,sa.replace(anchor,anchor+notice)))
for changed in ['',sa.replace(caption,caption.replace('Table 1:','Table 2:')),sa.replace('Abbrev.\nConditioning\nLoss Norm.','Abbrev.\nAccuracy\nLoss Norm.'),sa.replace('UC-N\n–\n✓\n–','UC-N\n–\n–\n–'),sa.replace('UC-N\n–\n✓\n–','UNOBSERVED\n–\n✓\n–'),sa.replace('UC-N\n–\n✓\n–','Table 2: Another experiment.\nUC-N\n–\n✓\n–'),'```text\n'+sa+'\n```',sa.replace('\n4 Results\n','\nThis procedure was not implemented.\n4 Results\n')]:
    check('reject loss source/body '+str(len(checks)),not m._source_bound_loss_switch_columns(ta,changed))
for tag in ('blockquote','pre','code'):
    check('reject HTML quoted loss source '+tag,not m._source_bound_loss_switch_columns(ta,'<'+tag+'>'+sa+'</'+tag+'>'))
# All source/body mutations below are SYNTHETIC negative probes of the saved real table.
sb=b['sourceText'];tb1,tb2=table(b),table(b,1);cap1=re.search(r'^Table \d+: Rejections at n=780[^\n]+$',sb,re.M)[0];cap2=re.search(r'^A\.\d+ Power against sample size in vision\.[^\n]+$',sb,re.M)[0]
for t in [tb1,tb2]:check('real kernel axis '+str(len(checks)),m._source_backed_kernel_setting_axes(t,sb)=={0})
for t in [tb1,tb2]:
    for header in ['准确率','原始得分 ↑','未知轴']:
        changed=copy.deepcopy(t);changed['header'][0]=header;check('reject false kernel axis '+str(len(checks)),not m._source_backed_kernel_setting_axes(changed,sb))
    for mutated in [dict(t,rows=t['rows'][:-1]),dict(t,rows=t['rows']+[t['rows'][0]]),dict(t,rows=[t['rows'][0]]*len(t['rows']))]:check('reject incomplete kernel axis '+str(len(checks)),not m._source_backed_kernel_setting_axes(mutated,sb))
for changed in [sb.replace(cap1,cap1.replace('780','781')),sb.replace('\ncontraction, s=0.1s{=}0.1\n','\nunknown contraction\n'),sb.replace('\nrank-2 rotation\nCLaMP\u00a02, PANNs\n4–7/50\n0–2/50\n30–39/50\n36–44/50\n–\n','\n'),sb.replace('\nrank-1 inflation\n','\nrank-1 deflation\n'),sb.replace('\ncontrol\nall five\nat most 3/20 per cell\n0–2/20\n','\n'),sb.replace('\nmedian\ncubic\nwindow\nMMDAgg\nFréchet\n','\ncubic\nmedian\nwindow\nMMDAgg\nFréchet\n')]:
    check('negative perturbation actually changed '+str(len(checks)),changed!=sb);check('reject broken full perturbation source '+str(len(checks)),not m._source_backed_kernel_setting_axes(tb1,changed))
for vals in ['n/a\n3/20\n17/20\n10/10\n5/5','3/20\nn/a\n17/20\n10/10\n5/5','3/20\n3/20\nn/a\n10/10\n5/5','3/10\n3/20\n17/20\n10/10\n5/5']:
    changed=sb.replace('rotation\nmedian\n3/20\n3/20\n17/20\n10/10\n5/5','rotation\nmedian\n'+vals);check('changed source grid '+str(len(checks)),changed!=sb);check('reject new n/a or wrong denominator '+str(len(checks)),not m._source_backed_kernel_setting_axes(tb2,changed))
for changed in [sb.replace('\ncontrol\nmedian\n0/20\n2/20\n0/20\n1/10\nn/a','\ncontrol'),sb.replace('A.19 Injected copies.','This experiment was never performed.\nA.19 Injected copies.')]:check('reject sample source row/removal/revocation '+str(len(checks)),not m._source_backed_kernel_setting_axes(tb2,changed))
for cap,t in [(cap1,tb1),(cap2,tb2)]:
    for prefix in ['Previous work.','Hypothetical experiment.','This experiment was not performed.','Third-party research.']:
        check('reject source local foreign/conditional '+str(len(checks)),not m._source_backed_kernel_setting_axes(t,sb.replace(cap,prefix+'\n'+cap)))
    for changed in ['```\n'+sb+'\n```','<blockquote>'+sb+'</blockquote>',sb.replace(cap,cap+' This was only hypothetical.')]:check('reject source quoted/revoked '+str(len(checks)),not m._source_backed_kernel_setting_axes(t,changed))
paragraph=next(p for p in re.split(r'\n\s*\n',m._extract_analysis_section(b['analysis'],'实验结果')) if p.startswith('中位数带宽对旋转从'))
check('real sample boundary',m._source_backed_sample_size_boundary(paragraph,tb2,sb))
for prefix in ['Previous work.','第三方研究。','Hypothetical experiment.','引述：']:
    check('reject inherited paragraph scope '+prefix,not m._source_backed_sample_size_boundary(paragraph,tb2,sb,prefix+'\n\n'+paragraph));check('explicit independent paragraph resets foreign '+prefix,m._source_backed_sample_size_boundary(paragraph,tb2,sb,prefix+'\n\n旧结果。\n\n本文实测结果：\n\n'+paragraph))
for changed in ['若'+paragraph,'假设'+paragraph,'第三方研究：'+paragraph,paragraph+'上述扫描未实际执行。','“'+paragraph+'”',paragraph.replace('2/10','3/10'),paragraph.replace('不能推广为三次核的高功效区间','可以推广为三次核的高功效区间').replace('不据此建立高功效趋势','据此建立高功效趋势')]+['<'+tag+'>'+paragraph+'</'+tag+'>' for tag in ['blockquote','pre','code']]:check('reject false boundary '+str(len(checks)),not m._source_backed_sample_size_boundary(changed,tb2,sb))
for context in ['```\n'+paragraph+'\n```','<code class="quote">\n'+paragraph+'\n</code>',paragraph+'\n\n上述样本量扫描结论已撤回。',paragraph+'\n\nThis was only hypothetical.',paragraph+'\n\nWe did not actually perform this experiment.']:check('reject boundary surrounding scope '+str(len(checks)),not m._source_backed_sample_size_boundary(paragraph,tb2,sb,context))
check('unrelated denial is not experiment revocation',m._source_backed_sample_size_boundary(paragraph,tb2,sb,paragraph+'\n\nWe did not use a GPU.'))
# Even observed categorical axes do not exempt missing metric direction or numeric evidence.
check('categorical switch does not exempt metric direction',validate(a,analysis=a['analysis'].replace('波形损失归一化 |','准确率 |')) is not None)
check('kernel axis does not exempt metric direction',validate(b,analysis=b['analysis'].replace('中位数高斯 $\\uparrow$','准确率')) is not None)
print(json.dumps({'checked':len(checks),'checks':checks,'fixtureSha256':sha(raw),'moduleSha256':sha(source),'modelRequests':0,'networkRequests':0,'readonly':True},ensure_ascii=False))
