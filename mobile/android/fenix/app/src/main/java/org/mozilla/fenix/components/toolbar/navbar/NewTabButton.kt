/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.components.toolbar.navbar

import android.content.Context
import android.content.res.Configuration
import android.util.AttributeSet
import android.view.LayoutInflater
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Button
import android.widget.RelativeLayout
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.material.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import mozilla.components.compose.base.annotation.LightDarkPreview
import mozilla.components.ui.tabcounter.TabCounterMenu
import org.mozilla.fenix.R
import org.mozilla.fenix.databinding.NewTabButtonBinding
import org.mozilla.fenix.theme.FirefoxTheme
import org.mozilla.fenix.theme.Theme

// Interim composable for a new tab button that supports showing a menu on long press.
// With this being implemented as an AndroidView the menu can be shown as low to the bottom of the
// screen as needed. To be replaced with a fully Compose implementation in the future that use a
// DropdownMenu once https://github.com/JetBrains/compose-multiplatform/issues/1878 is resolved.

/**
 * Composable that delegates to an [AndroidView] to display a new tab button and optionally a menu.
 *
 * If a menu is provided it will be shown as low to the bottom of the screen as needed and will
 * be shown on long presses of the tab counter button irrespective of the [onLongPress] callback
 * being set or not.
 *
 * @param onClick Invoked when the button is clicked.
 * @param menu Optional menu to show when the button is long clicked.
 * @param onLongPress Optional callback for when the button is long clicked.
 */
@Composable
fun NewTabButton(
    onClick: () -> Unit,
    menu: TabCounterMenu? = null,
    onLongPress: () -> Unit = {},
) {
    val isRtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    AndroidView(
        factory = { context ->
            NewTabButton(context).apply {
                setOnClickListener {
                    onClick()
                }

                menu?.let { menu ->
                    setOnLongClickListener {
                        onLongPress()
                        menu.menuController.show(anchor = it)
                        true
                    }
                }

                contentDescription = context.getString(R.string.library_new_tab)

                accessibilityDelegate = object : View.AccessibilityDelegate() {
                    override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfo) {
                        super.onInitializeAccessibilityNodeInfo(host, info)
                        info.className = Button::class.java.name
                    }
                }

                setBackgroundResource(R.drawable.mozac_material_ripple_minimum_interaction_size)
            }
        },
        modifier = Modifier
            .minimumInteractiveComponentSize()
            .testTag(NavBarTestTags.NEW_TAB_BUTTON),
        update = { newTabButton ->
            newTabButton.layoutDirection = if (isRtl) {
                View.TEXT_DIRECTION_RTL
            } else {
                View.TEXT_DIRECTION_LTR
            }
        },
    )
}

private class NewTabButton @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0,
) : RelativeLayout(context, attrs, defStyle) {

    init {
        NewTabButtonBinding.inflate(LayoutInflater.from(context), this)
    }
}

@LightDarkPreview
@Composable
private fun NewTabButtonPreview() {
    FirefoxTheme {
        Box(
            modifier = Modifier
                .background(FirefoxTheme.colors.layer1)
                .padding(10.dp),
        ) {
            NewTabButton(
                onClick = {},
            )
        }
    }
}

@Preview(uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun NewTabButtonPrivatePreview() {
    FirefoxTheme(theme = Theme.Private) {
        Box(
            modifier = Modifier
                .background(FirefoxTheme.colors.layer1)
                .padding(10.dp),
        ) {
            NewTabButton(
                onClick = {},
            )
        }
    }
}
