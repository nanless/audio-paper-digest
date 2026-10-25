package com.nanless.paperdigest.ui

import androidx.compose.material3.*
import androidx.compose.ui.graphics.Color

/** All tonal containers belong to the same blue-gray family, including chips, cards and navigation. */
internal fun paperColorScheme(dark:Boolean):ColorScheme=if(dark)darkColorScheme(
 primary=Color(0xFFA7C7F5),onPrimary=Color(0xFF163357),primaryContainer=Color(0xFF24466E),onPrimaryContainer=Color(0xFFD7E7FF),
 secondary=Color(0xFFB8C8DC),onSecondary=Color(0xFF243448),secondaryContainer=Color(0xFF30455E),onSecondaryContainer=Color(0xFFDDE9F8),
 tertiary=Color(0xFFADCEC9),onTertiary=Color(0xFF173A35),tertiaryContainer=Color(0xFF2D504A),onTertiaryContainer=Color(0xFFD1EEE7),
 background=Color(0xFF10171F),onBackground=Color(0xFFE3EAF3),surface=Color(0xFF131C26),onSurface=Color(0xFFE3EAF3),
 surfaceVariant=Color(0xFF344150),onSurfaceVariant=Color(0xFFBCC9D8),outline=Color(0xFF8796A7),outlineVariant=Color(0xFF354453),
 surfaceContainerLowest=Color(0xFF0B121A),surfaceContainerLow=Color(0xFF18222D),surfaceContainer=Color(0xFF1C2835),surfaceContainerHigh=Color(0xFF243242),surfaceContainerHighest=Color(0xFF2D3D4F),
 inverseSurface=Color(0xFFE1E9F3),inverseOnSurface=Color(0xFF233345),inversePrimary=Color(0xFF315F9B),surfaceTint=Color(0xFFA7C7F5),
)else lightColorScheme(
 primary=Color(0xFF315F9B),onPrimary=Color.White,primaryContainer=Color(0xFFDCE9FB),onPrimaryContainer=Color(0xFF1A365A),
 secondary=Color(0xFF526780),onSecondary=Color.White,secondaryContainer=Color(0xFFE1EBF7),onSecondaryContainer=Color(0xFF263C56),
 tertiary=Color(0xFF406C64),onTertiary=Color.White,tertiaryContainer=Color(0xFFDAEEE8),onTertiaryContainer=Color(0xFF24463F),
 background=Color(0xFFF3F6FB),onBackground=Color(0xFF1D2A39),surface=Color(0xFFF8FAFE),onSurface=Color(0xFF1D2A39),
 surfaceVariant=Color(0xFFE4EAF3),onSurfaceVariant=Color(0xFF516174),outline=Color(0xFF75869A),outlineVariant=Color(0xFFCCD6E3),
 surfaceContainerLowest=Color.White,surfaceContainerLow=Color(0xFFFFFFFF),surfaceContainer=Color(0xFFEDF3FB),surfaceContainerHigh=Color(0xFFE5EDF7),surfaceContainerHighest=Color(0xFFDDE7F3),
 inverseSurface=Color(0xFF293849),inverseOnSurface=Color(0xFFEAF1FA),inversePrimary=Color(0xFFA7C7F5),surfaceTint=Color(0xFF315F9B),
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
