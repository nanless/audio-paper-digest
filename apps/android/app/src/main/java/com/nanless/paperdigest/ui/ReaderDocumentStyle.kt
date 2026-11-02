package com.nanless.paperdigest.ui

/** Phone reading has its own layout; export/printing retain their existing document contract. */
internal fun readerTextZoom(fontSize:Int,fontScale:Float):Int =
    ((fontSize.takeIf{it>0}?:18)/18f*(fontScale.takeIf{it.isFinite()&&it>0}?:1f)*100).toInt().coerceAtLeast(50)

internal fun readerDocumentHead(background:Int,foreground:Int,link:Int,imageSource:String="data:"):String {
    fun css(color:Int)="#%06x".format(color and 0xffffff)
    return """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src $imageSource; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>
body{max-width:76ch;margin:16px auto;padding:0 14px;font:16px/1.65 system-ui,sans-serif;background:${css(background)};color:${css(foreground)}}
h1,h2,h3,h4,h5,h6{line-height:1.35;overflow-wrap:anywhere}h1{font-size:1.4em;margin:0 0 .8em}h2{font-size:1.22em;margin:1.5em 0 .6em}h3{font-size:1.1em;margin:1.2em 0 .5em}p{margin:.75em 0}a{color:${css(link)};overflow-wrap:anywhere}img{max-width:100%;height:auto}figure{margin:1em 0}figcaption{font-size:.9em;line-height:1.5}
table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse}td,th{padding:6px;border:1px solid #aeb8be}th{white-space:nowrap;overflow-wrap:normal;word-break:normal}td>a:only-child{display:inline-block;width:max-content;max-width:min(24em,calc(100vw - 28px))}pre{max-width:100%;overflow-x:auto;white-space:pre-wrap}blockquote{margin:1em 0;padding-left:12px;border-left:3px solid ${css(link)}}math[display=block]{display:block;max-width:100%;overflow-x:auto;margin:1em 0}body{overflow-wrap:break-word}
</style></head><body>"""
}
