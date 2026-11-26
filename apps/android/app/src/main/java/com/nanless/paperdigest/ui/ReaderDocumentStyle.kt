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
    val bgR=((background ushr 16) and 0xff)/255.0
    val bgG=((background ushr 8) and 0xff)/255.0
    val bgB=(background and 0xff)/255.0
    val isDark=(0.2126*bgR+0.7152*bgG+0.0722*bgB)<0.2
    val borderCol=if(isDark)"rgba(237,232,223,.14)" else "rgba(28,26,23,.13)"
    val strongBorder=if(isDark)"rgba(237,232,223,.22)" else "rgba(28,26,23,.20)"
    val cardBg=if(isDark)"rgba(255,255,255,.04)" else "rgba(15,92,88,.035)"
    val cardAltBg=if(isDark)"rgba(255,255,255,.065)" else "rgba(28,26,23,.035)"
    val thBg=if(isDark)"rgba(94,202,192,.14)" else "rgba(15,92,88,.09)"
    val codeBg=if(isDark)"rgba(255,255,255,.08)" else "rgba(28,26,23,.06)"
    val mutedInk=if(isDark)"#b0aaa0" else "#555048"
    val copperAccent=if(isDark)"#e39b6d" else "#964624"
    val copperBg=if(isDark)"rgba(227,155,109,.12)" else "rgba(150,70,36,.07)"
    val copperBorder=if(isDark)"rgba(227,155,109,.32)" else "rgba(150,70,36,.26)"
    val figureImgCss=if(isDark)"figure img,p>img{background:#faf8f4;padding:8px;border-radius:10px;border:1px solid rgba(237,232,223,.16);box-sizing:border-box}" else "figure img,p>img{border-radius:8px;border:1px solid rgba(28,26,23,.10);box-sizing:border-box}"
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
body{line-height:1.68;padding:4px 14px 28px}
h2{padding-bottom:.28em;border-bottom:1px solid $borderCol;margin:1.35em 0 .55em}
h3{margin:1.1em 0 .42em}
p{margin:.68em 0}
blockquote{margin:.85em 0;padding:.55em .9em;border-left:3px solid ${css(link)};border-radius:0 8px 8px 0;background:$cardBg}
code{padding:.12em .36em;border-radius:5px;background:$codeBg;font-size:.9em}
pre{padding:.75em .9em;border:1px solid $borderCol;border-radius:10px;background:$cardAltBg;line-height:1.5}
pre code{padding:0;background:transparent;font-size:.88em}
figure{margin:1em 0;text-align:center}
figcaption{margin-top:.45em;font-size:.88em;line-height:1.5;color:$mutedInk;text-align:left}
$figureImgCss
table{margin:.85em 0;border-radius:8px}
td,th{padding:6px 9px;border:1px solid $borderCol}
thead th{background:$thBg;font-weight:600}
tbody tr:nth-child(even) td{background:$cardAltBg}
.paper-tags,.paper-tags--aggregate{margin:.75em 0;padding:.7em .85em;border:1px solid $borderCol;border-radius:10px;background:$cardBg}
.classification-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;margin-top:.5em}
.classification-card{padding:.55em .7em;border:1px solid $borderCol;border-radius:8px;background:$cardAltBg}
.classification-tree{list-style:none;padding-left:0;margin:.3em 0}
.classification-tree ul{list-style:none;padding-left:.85em;margin:.2em 0;border-left:1px solid $borderCol}
.classification-node{display:inline-block;padding:2px 8px;margin:2px 4px 2px 0;border-radius:999px;font-size:.84em;border:1px solid $strongBorder;background:$cardBg;text-decoration:none}
.reader-roadmap-title{font-weight:600;font-size:.95em;margin:0 0 .4em;color:${css(link)}}
.reader-roadmap-list{margin:.3em 0 0;padding-left:1.3em}
.reader-roadmap-list li{margin:.25em 0}
.audio-spec-quick-header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px;margin-bottom:.45em}
.audio-spec-quick-title{font-weight:700;font-size:.96em;color:${css(link)}}
.audio-demo-cta-wrap{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:.55em}
.resource-primary-note,.reader-content-notice{margin:.65em 0;padding:.55em .8em;border:1px solid $borderCol;border-left:3px solid ${css(link)};border-radius:8px;background:$cardBg;font-size:.9em}
.image-unavailable-notice{margin:.65em 0;padding:.6em .85em;border:1px solid $copperBorder;border-left:3px solid $copperAccent;border-radius:8px;background:$copperBg;font-size:.89em}
.image-original-description{margin:.35em 0 .6em;padding:.45em .75em;border-radius:6px;background:$cardAltBg;font-size:.87em;color:$mutedInk}
.scoring-weights-strip{display:flex;flex-wrap:wrap;gap:6px;margin:.5em 0;padding:.45em .65em;border:1px solid $borderCol;border-radius:8px;background:$cardAltBg;font-size:.84em}
.scoring-audit-meta{font-size:.85em;color:$mutedInk;margin:.3em 0 .55em}
.math-fallback{display:inline-block;padding:.12em .4em;border:1px dashed $strongBorder;border-radius:5px;background:$cardAltBg;font-family:ui-monospace,monospace;font-size:.9em}
.highlight,.chroma{margin:.75em 0;padding:.7em .85em;border:1px solid $borderCol;border-radius:10px;background:$cardAltBg;overflow-x:auto}
.highlight pre,.chroma pre{margin:0;padding:0;border:none;background:transparent}
</style></head><body>"""
}
