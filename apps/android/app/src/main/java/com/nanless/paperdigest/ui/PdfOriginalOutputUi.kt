package com.nanless.paperdigest.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.nanless.paperdigest.data.ReadingSourceBinding
import com.nanless.paperdigest.pdf.*
import kotlinx.coroutines.*

/** Testable UI handoff seam; production always uses the actual platform helpers below. */
internal interface PdfOriginalOutputActions {
 suspend fun inspect(snapshot:PdfOriginalSnapshot):PdfOriginalPrintReadiness
 suspend fun share(activity:Activity,snapshot:PdfOriginalSnapshot):String
 suspend fun print(activity:Activity,snapshot:PdfOriginalSnapshot,password:String):String
}
private object ActualPdfOriginalOutputActions:PdfOriginalOutputActions {
 override suspend fun inspect(snapshot:PdfOriginalSnapshot)=PdfOriginalPrintAdapter.inspect(snapshot)
 override suspend fun share(activity:Activity,snapshot:PdfOriginalSnapshot)=PdfOriginalShare.openChooser(activity,snapshot)
 override suspend fun print(activity:Activity,snapshot:PdfOriginalSnapshot,password:String)=PdfOriginalPrintAdapter.openPreview(activity,snapshot,password)
}

internal fun canOutputCurrentPdf(state:UiState):Boolean {
 val paper=state.viewedPaper?.takeIf{it.id==state.selectedPaperId}?:state.papers.firstOrNull{it.id==state.selectedPaperId}?:return false
 val document=state.pdfDocument?:return false
 if(!state.pdfMode||state.readingMaterialID.isBlank())return false
 return try{ReadingSourceBinding.requirePDF(paper,state.pdfReceipt,document.sha256);true}catch(_:Exception){false}
}

/** Ephemeral UI ownership only. No password, path or output capability is serializable state. */
internal class PdfOriginalOutputSession(
 private val controller:AppController,private val context:Context,private val scope:CoroutineScope,
 private val owner:String,private val token:String,private val originalSHA:String,
 private val actions:PdfOriginalOutputActions=ActualPdfOriginalOutputActions
) {
 var busy by mutableStateOf(false);private set
 var stopping by mutableStateOf(false);private set
 var passwordRequested by mutableStateOf(false);private set
 var error by mutableStateOf<String?>(null);private set
 var message by mutableStateOf<String?>(null);private set
 private var disposed=false
 private var job:Job?=null
 private var owned:PdfOriginalSnapshot?=null
 private fun current() {
  check(!disposed){"原文输出窗口已关闭"}
  val now=controller.state.value
  require(now.selectedPaperId==owner&&now.readingMaterialID==token&&now.pdfDocument?.sha256==originalSHA&&canOutputCurrentPdf(now)){"阅读材料已变化，未输出另一篇论文或另一版本原文。"}
 }
 private fun activity():Activity {
  var value=context;val seen=java.util.Collections.newSetFromMap(java.util.IdentityHashMap<Context,Boolean>())
  while(seen.add(value)) {
   if(value is Activity){require(!value.isFinishing&&!value.isDestroyed){"当前窗口已关闭，未打开旧原件输出"};return value}
   value=(value as? ContextWrapper)?.baseContext?:break
  }
  throw IllegalStateException("当前没有可用的应用窗口，未打开系统原文输出。")
 }
 fun beginShare()=begin(false)
 fun beginPrint()=begin(true)
 private fun begin(printing:Boolean) {
  if(busy||passwordRequested||disposed)return
  busy=true;error=null;message=null;stopping=false
  job=scope.launch {
   var prepared:PdfOriginalSnapshot?=null
   try {
    current();val host=activity()
    prepared=controller.prepareOriginalPdfOutput(token)
    owned=prepared;current()
    val readiness=if(printing)actions.inspect(prepared)else PdfOriginalPrintReadiness.READY
    current()
    if(printing&&readiness==PdfOriginalPrintReadiness.PASSWORD_REQUIRED)passwordRequested=true
    else {
     message=if(printing)actions.print(host,prepared,"")else actions.share(host,prepared)
     owned=null
    }
   } catch(cancelled:CancellationException) {
    passwordRequested=false
    if(!disposed)message=if(prepared?.hasBeenHandedOff==true)"系统输出已交接；请在系统面板查看实际结果。" else "本次原文输出已停止，原文件保留。"
    throw cancelled
   } catch(failure:Exception) {
    passwordRequested=false
    if(!disposed)error=failure.message?:"无法准备当前原文输出；原文件保留。"
   } finally {
    if(!passwordRequested){prepared?.discardIfUnhanded();if(owned===prepared)owned=null}
    busy=false;stopping=false
   }
  }
 }
 fun submitPrintPassword(password:String) {
  if(busy||!passwordRequested||disposed)return
  val prepared=owned?:run{passwordRequested=false;error="本次原文准备已结束，请重新打开打印。";return}
  busy=true;stopping=false;error=null
  job=scope.launch {
   try {
    current();val host=activity()
    // The value goes directly to the local helper. It never enters execute(), settings, tasks or SavedState.
    message=actions.print(host,prepared,password)
    passwordRequested=false;owned=null
   } catch(cancelled:CancellationException) {
    passwordRequested=false
    if(!disposed)message=if(prepared.hasBeenHandedOff)"打印预览已交接；尚未确认打印完成。" else "本次打印已停止，原文件保留。"
    throw cancelled
   } catch(_:PdfOriginalPrintPasswordRequired) {
    if(!disposed)error="密码为空或不正确，请重新输入本次打印密码。"
   } catch(failure:Exception) {
    passwordRequested=false
    if(!disposed)error=failure.message?:"当前原文无法按此权限打印；原文件保留。"
   } finally {
    if(!passwordRequested){prepared.discardIfUnhanded();if(owned===prepared)owned=null}
    busy=false;stopping=false
   }
  }
 }
 fun cancel() {
  if(busy){stopping=true;job?.cancel();return}
  passwordRequested=false;owned?.discardIfUnhanded();owned=null;error=null
  message="已取消本次原文输出，原文件保留。"
 }
 fun dismissMessage(){message=null;error=null}
 fun dispose(){disposed=true;job?.cancel();passwordRequested=false;owned?.discardIfUnhanded();owned=null}
}

@Composable internal fun PdfOriginalOutputMenuItems(enabled:Boolean,session:PdfOriginalOutputSession,closeMenu:()->Unit) {
 DropdownMenuItem(text={Text("分享 PDF 原件…")},onClick={closeMenu();session.beginShare()},enabled=enabled&&!session.busy&&!session.passwordRequested)
 DropdownMenuItem(text={Text("打印 PDF 原件…")},onClick={closeMenu();session.beginPrint()},enabled=enabled&&!session.busy&&!session.passwordRequested)
}

@Composable internal fun PdfOriginalOutputDialogs(session:PdfOriginalOutputSession) {
 if(session.passwordRequested) {
  // Deliberately remember, never rememberSaveable: rotation/source change disposes the secret field.
  var password by remember(session){mutableStateOf("")}
  DisposableEffect(session){onDispose{password=""}}
  LaunchedEffect(session.error){if(session.error!=null)password=""}
  AlertDialog(onDismissRequest={password="";session.cancel()},title={Text("本次 PDF 打印密码")},text={
   Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(12.dp)) {
    Text("当前原件需要密码。密码仅用于本次本机打印，不进入设置、任务、日志或研究备份；原加密 PDF 不改写。")
    CredentialPasswordField(password,{password=it.take(4096)},label="本次打印密码",enabled=!session.busy)
    session.error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
    if(session.busy){LinearProgressIndicator(Modifier.fillMaxWidth());Text(if(session.stopping)"正在停止，请等原文操作关闭…" else "正在核对原件与打印权限…")}
   }
  },confirmButton={TextButton({val submitted=password;password="";session.submitPrintPassword(submitted)},enabled=!session.busy){Text("核对并打开预览")}},dismissButton={TextButton({password="";session.cancel()}){Text(if(session.busy)"请求停止" else "取消本次打印")}})
 } else if(session.busy) {
  AlertDialog(onDismissRequest=session::cancel,title={Text("准备原文输出")},text={Column(verticalArrangement=Arrangement.spacedBy(12.dp)){
   LinearProgressIndicator(Modifier.fillMaxWidth())
   Text(if(session.stopping)"已请求停止，正在等待原文操作关闭；尚未报告停止。" else "正在核对当前原件与阅读来源。原 PDF 不改写；系统面板打开后仍需确认实际结果。")
  }},confirmButton={TextButton(session::cancel,enabled=!session.stopping){Text(if(session.stopping)"正在停止…" else "请求停止")}})
 } else if(session.error!=null||session.message!=null) {
  AlertDialog(onDismissRequest=session::dismissMessage,title={Text("原文输出")},text={Text(session.error?:session.message.orEmpty())},confirmButton={TextButton(session::dismissMessage){Text("知道了")}})
 }
}
