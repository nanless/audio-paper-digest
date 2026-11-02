package com.nanless.paperdigest.ui

/** Phone reading has its own layout; export/printing retain their existing document contract. */
internal fun readerTextZoom(fontSize:Int,fontScale:Float):Int =
    ((fontSize.takeIf{it>0}?:18)/18f*(fontScale.takeIf{it.isFinite()&&it>0}?:1f)*100).toInt().coerceAtLeast(50)

internal fun readerDocumentHead(background:Int,foreground:Int,link:Int,imageSource:String="data:"):String {
    fun css(color:Int)="#%06x".format(color and 0xffffff)
    return """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src $imageSource; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{max-width:76ch;margin:10px auto;padding:0 10px;font:14px/1.5 system-ui,sans-serif;background:${css(background)};color:${css(foreground)}}
h1,h2,h3,h4,h5,h6{line-height:1.3;overflow-wrap:anywhere}h1{font-size:1.2857em;margin:0 0 .6em}h2{font-size:1.1429em;margin:1em 0 .45em}h3{font-size:1.0714em;margin:.9em 0 .4em}h4,h5,h6{font-size:1em;margin:.8em 0 .4em}p{margin:.55em 0}ul,ol{padding-left:1.5em;margin:.55em 0}li{margin:.15em 0}li>p{margin:.3em 0}a{color:${css(link)};overflow-wrap:anywhere}img{max-width:100%;height:auto}figure{margin:.75em 0}figcaption{font-size:.9em;line-height:1.45}
table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse}td,th{padding:4px;border:1px solid #aeb8be}th{white-space:nowrap;overflow-wrap:normal;word-break:normal}td>a:only-child{display:inline-block;width:max-content;max-width:min(24em,calc(100vw - 20px))}pre{max-width:100%;overflow-x:auto;white-space:pre-wrap}blockquote{margin:.65em 0;padding-left:10px;border-left:3px solid ${css(link)}}math[display=block]{display:block;max-width:100%;overflow-x:auto;margin:.75em 0}body{overflow-wrap:break-word}
</style></head><body>"""
}
