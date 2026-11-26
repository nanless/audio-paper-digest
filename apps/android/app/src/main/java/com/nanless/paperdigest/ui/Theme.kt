package com.nanless.paperdigest.ui

import androidx.compose.material3.*
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Studio Monograph: WCAG-verified warm archival paper light mode & slate-ink dark mode with studio teal + copper accents. */
internal fun paperColorScheme(dark:Boolean):ColorScheme=if(dark)darkColorScheme(
 primary=Color(0xFF5ECAC0),onPrimary=Color(0xFF062B28),primaryContainer=Color(0xFF184643),onPrimaryContainer=Color(0xFFD1F3EF),
 secondary=Color(0xFFB4C2BE),onSecondary=Color(0xFF1E2725),secondaryContainer=Color(0xFF293332),onSecondaryContainer=Color(0xFFDCE4E1),
 tertiary=Color(0xFFE39B6D),onTertiary=Color(0xFF3A1907),tertiaryContainer=Color(0xFF572B14),onTertiaryContainer=Color(0xFFFDE1CE),
 background=Color(0xFF121617),onBackground=Color(0xFFEDE8DF),surface=Color(0xFF121617),onSurface=Color(0xFFEDE8DF),
 surfaceVariant=Color(0xFF252D2F),onSurfaceVariant=Color(0xFFB0AAA0),outline=Color(0xFF8C877E),outlineVariant=Color(0xFF364042),
 surfaceContainerLowest=Color(0xFF0D1112),surfaceContainerLow=Color(0xFF181E1F),surfaceContainer=Color(0xFF1E2628),surfaceContainerHigh=Color(0xFF263032),surfaceContainerHighest=Color(0xFF303B3E),
 error=Color(0xFFF2B8B5),onError=Color(0xFF601410),errorContainer=Color(0xFF8C1D18),onErrorContainer=Color(0xFFF9DEDC),
 inverseSurface=Color(0xFFEDE8DF),inverseOnSurface=Color(0xFF1C1A17),inversePrimary=Color(0xFF0F5C58),surfaceTint=Color(0xFF5ECAC0),
)else lightColorScheme(
 primary=Color(0xFF0F5C58),onPrimary=Color.White,primaryContainer=Color(0xFFD8ECE9),onPrimaryContainer=Color(0xFF0A3633),
 secondary=Color(0xFF4E5754),onSecondary=Color.White,secondaryContainer=Color(0xFFE6E9E6),onSecondaryContainer=Color(0xFF1F2624),
 tertiary=Color(0xFF964624),onTertiary=Color.White,tertiaryContainer=Color(0xFFF6E2D5),onTertiaryContainer=Color(0xFF53230E),
 background=Color(0xFFFAF8F4),onBackground=Color(0xFF1C1A17),surface=Color(0xFFFAF8F4),onSurface=Color(0xFF1C1A17),
 surfaceVariant=Color(0xFFEAE5DC),onSurfaceVariant=Color(0xFF555048),outline=Color(0xFF767067),outlineVariant=Color(0xFFD6CFC3),
 surfaceContainerLowest=Color.White,surfaceContainerLow=Color(0xFFF4F1EA),surfaceContainer=Color(0xFFEFECE4),surfaceContainerHigh=Color(0xFFE8E3D9),surfaceContainerHighest=Color(0xFFE0DACE),
 error=Color(0xFFB3261E),onError=Color.White,errorContainer=Color(0xFFF9DEDC),onErrorContainer=Color(0xFF410E0B),
 inverseSurface=Color(0xFF1C1A17),inverseOnSurface=Color(0xFFFAF8F4),inversePrimary=Color(0xFF5ECAC0),surfaceTint=Color(0xFF0F5C58),
)

internal val paperTypography=Typography(
 displaySmall=TextStyle(fontSize=32.sp,lineHeight=40.sp,fontWeight=FontWeight.SemiBold,letterSpacing=(-0.3).sp),
 headlineLarge=TextStyle(fontSize=28.sp,lineHeight=36.sp,fontWeight=FontWeight.SemiBold,letterSpacing=(-0.2).sp),
 headlineMedium=TextStyle(fontSize=25.sp,lineHeight=33.sp,fontWeight=FontWeight.SemiBold,letterSpacing=(-0.15).sp),
 headlineSmall=TextStyle(fontSize=22.sp,lineHeight=30.sp,fontWeight=FontWeight.SemiBold,letterSpacing=(-0.1).sp),
 titleLarge=TextStyle(fontSize=19.sp,lineHeight=27.sp,fontWeight=FontWeight.SemiBold,letterSpacing=0.sp),
 titleMedium=TextStyle(fontSize=16.sp,lineHeight=24.sp,fontWeight=FontWeight.SemiBold,letterSpacing=0.sp),
 titleSmall=TextStyle(fontSize=14.sp,lineHeight=20.sp,fontWeight=FontWeight.SemiBold,letterSpacing=0.1.sp),
 bodyLarge=TextStyle(fontSize=16.sp,lineHeight=26.sp,letterSpacing=0.1.sp),
 bodyMedium=TextStyle(fontSize=14.sp,lineHeight=22.sp,letterSpacing=0.1.sp),
 bodySmall=TextStyle(fontSize=12.5.sp,lineHeight=19.sp,letterSpacing=0.1.sp),
 labelLarge=TextStyle(fontSize=14.sp,lineHeight=20.sp,fontWeight=FontWeight.SemiBold,letterSpacing=0.1.sp),
 labelMedium=TextStyle(fontSize=12.sp,lineHeight=17.sp,fontWeight=FontWeight.Medium,letterSpacing=0.2.sp),
 labelSmall=TextStyle(fontSize=11.sp,lineHeight=16.sp,fontWeight=FontWeight.Medium,letterSpacing=0.25.sp),
)
internal val paperShapes=Shapes(
 extraSmall=RoundedCornerShape(8.dp),small=RoundedCornerShape(12.dp),
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
