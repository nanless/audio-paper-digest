package com.nanless.paperdigest.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable internal fun PdfUnlockDialog(prompt:PdfUnlockPrompt,controller:AppController) {
    // The native request survives rotation, the password never does.
    var password by remember(prompt.requestID){mutableStateOf("")}
    var sending by remember(prompt.requestID){mutableStateOf(false)}
    var localError by remember(prompt.requestID){mutableStateOf<String?>(null)}
    val scope=rememberCoroutineScope()
    DisposableEffect(prompt.requestID){onDispose{password=""}}
    val busy=prompt.checking||prompt.stopping||sending
    fun stop() {
        password="";sending=true;localError=null
        scope.launch {try{controller.cancelPdfUnlock(prompt.requestID)}
            catch(cancelled:CancellationException){throw cancelled}
            catch(error:Exception){localError=error.message?:"停止请求未完成；原件保留"}
            finally{sending=false}}
    }
    AlertDialog(onDismissRequest={if(!prompt.stopping)stop()},title={Text("解锁本次 PDF 原件")},text={
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            Text(prompt.displayName)
            Text("密码仅在本次应用内存中用于读取当前加密原件，不进入设置、任务、日志或研究备份。原加密 PDF 与原 SHA 保持不变。")
            CredentialPasswordField(password,{password=it.take(4096)},label="本次原文密码",enabled=!busy)
            (localError?:prompt.message)?.let{Text(it,color=if(prompt.stopping)MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error)}
            if(busy){LinearProgressIndicator(Modifier.fillMaxWidth());Text(if(prompt.stopping)"正在等待原文操作关闭，尚未报告停止。" else "正在核对本次原件与文档权限…")}
        }
    },confirmButton={TextButton({
        val input=password.toCharArray();password="";sending=true;localError=null
        val submission = scope.launch {try{controller.unlockPdf(prompt.requestID,input)}
            catch(cancelled:CancellationException){throw cancelled}
            catch(error:Exception){localError=error.message?:"未完成本次解锁，请重新输入"}
            finally{input.fill('\u0000');sending=false}}
        // A cancelled scope can reject dispatch before the body/finally ever starts.
        submission.invokeOnCompletion { input.fill('\u0000') }
    },enabled=!busy){Text("核对并打开原件")}},dismissButton={TextButton(::stop,enabled=!prompt.stopping){Text(if(busy)"请求停止" else "取消本次打开")}})
}
