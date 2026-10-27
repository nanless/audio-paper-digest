package com.nanless.paperdigest.ui

import androidx.compose.material3.*
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Warm reading surfaces, graphite text, and a restrained blue accent in both appearances. */
internal fun paperColorScheme(dark:Boolean):ColorScheme=if(dark)darkColorScheme(
 primary=Color(0xFFA7C7F5),onPrimary=Color(0xFF163357),primaryContainer=Color(0xFF24466E),onPrimaryContainer=Color(0xFFD7E7FF),
 secondary=Color(0xFFB8C8DC),onSecondary=Color(0xFF243448),secondaryContainer=Color(0xFF30455E),onSecondaryContainer=Color(0xFFDDE9F8),
 tertiary=Color(0xFFADCEC9),onTertiary=Color(0xFF173A35),tertiaryContainer=Color(0xFF2D504A),onTertiaryContainer=Color(0xFFD1EEE7),
 background=Color(0xFF151719),onBackground=Color(0xFFE8E7E3),surface=Color(0xFF191C1F),onSurface=Color(0xFFE8E7E3),
 surfaceVariant=Color(0xFF343B43),onSurfaceVariant=Color(0xFFB8C2CC),outline=Color(0xFF89939D),outlineVariant=Color(0xFF394047),
 surfaceContainerLowest=Color(0xFF101214),surfaceContainerLow=Color(0xFF1E2226),surfaceContainer=Color(0xFF24292E),surfaceContainerHigh=Color(0xFF2A3036),surfaceContainerHighest=Color(0xFF333B43),
 inverseSurface=Color(0xFFE1E9F3),inverseOnSurface=Color(0xFF233345),inversePrimary=Color(0xFF315F9B),surfaceTint=Color(0xFFA7C7F5),
)else lightColorScheme(
 primary=Color(0xFF315F9B),onPrimary=Color.White,primaryContainer=Color(0xFFDCE9FB),onPrimaryContainer=Color(0xFF1A365A),
 secondary=Color(0xFF526780),onSecondary=Color.White,secondaryContainer=Color(0xFFE1EBF7),onSecondaryContainer=Color(0xFF263C56),
 tertiary=Color(0xFF406C64),onTertiary=Color.White,tertiaryContainer=Color(0xFFDAEEE8),onTertiaryContainer=Color(0xFF24463F),
 background=Color(0xFFF5F5F1),onBackground=Color(0xFF242A30),surface=Color(0xFFFAFAF7),onSurface=Color(0xFF242A30),
 surfaceVariant=Color(0xFFE8EBEC),onSurfaceVariant=Color(0xFF55616B),outline=Color(0xFF77828B),outlineVariant=Color(0xFFD9DEDF),
 surfaceContainerLowest=Color.White,surfaceContainerLow=Color(0xFFFFFFFF),surfaceContainer=Color(0xFFEEF0EE),surfaceContainerHigh=Color(0xFFE7EBEA),surfaceContainerHighest=Color(0xFFDFE5E5),
 inverseSurface=Color(0xFF293849),inverseOnSurface=Color(0xFFEAF1FA),inversePrimary=Color(0xFFA7C7F5),surfaceTint=Color(0xFF315F9B),
)

internal val paperTypography=Typography(
 displaySmall=TextStyle(fontSize=32.sp,lineHeight=40.sp,fontWeight=FontWeight.SemiBold,letterSpacing=0.sp),
 headlineLarge=TextStyle(fontSize=28.sp,lineHeight=36.sp,fontWeight=FontWeight.SemiBold,letterSpacing=0.sp),
 headlineMedium=TextStyle(fontSize=26.sp,lineHeight=34.sp,fontWeight=FontWeight.SemiBold,letterSpacing=0.sp),
 headlineSmall=TextStyle(fontSize=23.sp,lineHeight=31.sp,fontWeight=FontWeight.SemiBold,letterSpacing=0.sp),
 titleLarge=TextStyle(fontSize=20.sp,lineHeight=28.sp,fontWeight=FontWeight.SemiBold,letterSpacing=0.sp),
 titleMedium=TextStyle(fontSize=16.sp,lineHeight=24.sp,fontWeight=FontWeight.SemiBold,letterSpacing=0.sp),
 titleSmall=TextStyle(fontSize=14.sp,lineHeight=21.sp,fontWeight=FontWeight.Medium,letterSpacing=0.sp),
 bodyLarge=TextStyle(fontSize=16.sp,lineHeight=26.sp,letterSpacing=0.sp),
 bodyMedium=TextStyle(fontSize=14.sp,lineHeight=22.sp,letterSpacing=0.sp),
 bodySmall=TextStyle(fontSize=12.sp,lineHeight=19.sp,letterSpacing=0.sp),
 labelLarge=TextStyle(fontSize=14.sp,lineHeight=20.sp,fontWeight=FontWeight.Medium,letterSpacing=0.sp),
 labelMedium=TextStyle(fontSize=12.sp,lineHeight=18.sp,fontWeight=FontWeight.Medium,letterSpacing=0.sp),
 labelSmall=TextStyle(fontSize=11.sp,lineHeight=17.sp,fontWeight=FontWeight.Medium,letterSpacing=0.sp),
)
internal val paperShapes=Shapes(
 extraSmall=RoundedCornerShape(6.dp),small=RoundedCornerShape(10.dp),
 medium=RoundedCornerShape(16.dp),large=RoundedCornerShape(22.dp),extraLarge=RoundedCornerShape(28.dp),
)

/** Installed in the Activity Recomposer effect context, not just in a single button coroutine. */
class AppMotionDurationScale(context:android.content.Context,private val controller:AppController):androidx.compose.ui.MotionDurationScale {
 private val resolver=context.applicationContext.contentResolver
 override val scaleFactor:Float get() {
  if(controller.state.value.settings.optBoolean("reduceMotion"))return 0f
  val system=runCatching{android.provider.Settings.Global.getFloat(resolver,android.provider.Settings.Global.ANIMATOR_DURATION_SCALE,1f)}.getOrDefault(1f)
  return system.takeIf{it.isFinite()&&it>=0f}?:1f
 }
}
