package com.nanless.paperdigest.ui

/** Phone reading has its own layout; export/printing retain their existing document contract. */
internal fun readerTextZoom(fontSize:Int,fontScale:Float):Int =
    ((fontSize.takeIf{it>0}?:18)/18f*(fontScale.takeIf{it.isFinite()&&it>0}?:1f)*100).toInt().coerceAtLeast(50)

internal fun readerDocumentHead(background:Int,foreground:Int,link:Int,imageSource:String="data:"):String {
    fun css(color:Int)="#%06x".format(color and 0xffffff)
    val linkR=((link ushr 16) and 0xff)/255.0
    val linkG=((link ushr 8) and 0xff)/255.0
    val linkB=(link and 0xff)/255.0
    val linkLuminance=0.2126*linkR+0.7152*linkG+0.0722*linkB
    val demoBtnInk=if(linkLuminance>0.45)"#141b28" else "#ffffff"
    return """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src $imageSource; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{max-width:76ch;margin:10px auto;padding:0 10px;font:14px/1.5 system-ui,sans-serif;background:${css(background)};color:${css(foreground)}}
h1,h2,h3,h4,h5,h6{line-height:1.3;overflow-wrap:anywhere}h1{font-size:1.2857em;margin:0 0 .6em}h2{font-size:1.1429em;margin:1em 0 .45em}h3{font-size:1.0714em;margin:.9em 0 .4em}h4,h5,h6{font-size:1em;margin:.8em 0 .4em}p{margin:.55em 0}ul,ol{padding-left:1.5em;margin:.55em 0}li{margin:.15em 0}li>p{margin:.3em 0}a{color:${css(link)};overflow-wrap:anywhere}img{max-width:100%;height:auto}figure{margin:.75em 0}figcaption{font-size:.9em;line-height:1.45}
table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse}td,th{padding:4px;border:1px solid #aeb8be}th{white-space:nowrap;overflow-wrap:normal;word-break:normal}td.ta-left,th.ta-left{text-align:left}td.ta-center,th.ta-center{text-align:center}td.ta-right,th.ta-right{text-align:right}td>a:only-child{display:inline-block;width:max-content;max-width:min(24em,calc(100vw - 20px))}pre{max-width:100%;overflow-x:auto;white-space:pre-wrap}blockquote{margin:.65em 0;padding-left:10px;border-left:3px solid ${css(link)}}math[display=block]{display:block;max-width:100%;overflow-x:auto;margin:.75em 0}body{overflow-wrap:break-word}
.executive-abstract-card{margin:.75em 0;padding:.75em .9em;border:1px solid rgba(128,128,128,.28);border-left:3px solid ${css(link)};border-radius:8px;background:rgba(128,128,128,.07)}.reader-section-roadmap{margin:.75em 0;padding:.65em .85em;border:1px solid rgba(128,128,128,.24);border-radius:8px;background:rgba(128,128,128,.05)}.reader-role-pill,.reader-section-kicker{display:inline-block;font-size:.82em;font-weight:600;padding:1px 7px;border-radius:999px;border:1px solid rgba(128,128,128,.35);margin-right:6px}.compact-authors-line{font-size:.92em;opacity:.88;margin:.3em 0}.compact-authors-note{font-size:.86em;opacity:.76;margin:.2em 0 .6em}.primary-resources-list,.third-party-resources{margin:.55em 0;padding:.5em .75em;border-radius:6px;background:rgba(128,128,128,.06)}details{margin:.65em 0;padding:.45em .7em;border:1px solid rgba(128,128,128,.25);border-radius:6px}summary{cursor:pointer;font-weight:600}
.audio-spec-quick-card{margin:.85em 0;padding:.75em .9em;border:1px solid rgba(128,128,128,.28);border-left:3px solid ${css(link)};border-radius:10px;background:rgba(128,128,128,.06)}
.audio-spec-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:8px;margin-top:8px}
.audio-spec-grid>div,.audio-spec-item{padding:6px 8px;border:1px solid rgba(128,128,128,.2);border-radius:8px;background:rgba(128,128,128,.04);font-size:.9em}
a.audio-demo-cta-btn{display:inline-flex;align-items:center;gap:6px;margin:.35em .35em .2em 0;padding:6px 12px;border-radius:999px;background:${css(link)};color:$demoBtnInk;text-decoration:none;font-weight:600;font-size:.9em}
.implementation-specs-card{margin:.85em 0;padding:.75em .9em;border:1px solid rgba(128,128,128,.26);border-radius:10px;background:rgba(128,128,128,.05)}
.digest-brief-card{margin:.85em 0;padding:.8em .95em;border:1px solid rgba(128,128,128,.28);border-left:3px solid ${css(link)};border-radius:10px;background:rgba(128,128,128,.06)}
.digest-reading-tiers{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;margin:.75em 0}
.digest-spotlight-card{margin:.8em 0;padding:.8em .95em;border:1px solid rgba(128,128,128,.3);border-radius:10px;background:rgba(128,128,128,.07)}
details.compact-authors-details{margin:.35em 0 .65em;padding:.35em .65em;font-size:.92em;border-color:rgba(128,128,128,.22)}
details.index-abstract-more{margin:.45em 0 .65em;padding:.4em .7em;font-size:.94em}
.scoring-audit-card{margin:.85em 0;padding:.8em .95em;border:1px solid rgba(128,128,128,.28);border-radius:10px;background:rgba(128,128,128,.05)}
.scoring-evidence-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:.6em 0}
.scoring-strengths-box{margin:.55em 0;padding:.6em .8em;border:1px solid rgba(22,128,74,.35);border-left:3px solid #16804a;border-radius:8px;background:rgba(22,128,74,.07)}
.scoring-defects-box{margin:.55em 0;padding:.6em .8em;border:1px solid rgba(185,56,44,.35);border-left:3px solid #b9382c;border-radius:8px;background:rgba(185,56,44,.07)}
</style></head><body>"""
}
