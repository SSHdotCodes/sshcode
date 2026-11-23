package com.example.sshcode.quest

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.content.res.ColorStateList
import android.widget.ImageButton
import android.widget.LinearLayout

internal fun panelSurface(context: Context, radius: Int = 24, attention: Boolean = false) = GradientDrawable().apply {
    setColor(Color.argb(242, 27, 31, 30))
    cornerRadius = radius * context.resources.displayMetrics.density
    setStroke((context.resources.displayMetrics.density * if (attention) 3 else 1).toInt().coerceAtLeast(1),
        if (attention) Color.rgb(183, 196, 137) else Color.argb(65, 220, 235, 228))
}

internal fun panelIcon(parent: LinearLayout, icon: Int, description: String, action: () -> Unit): ImageButton = ImageButton(parent.context).apply {
    val density = resources.displayMetrics.density
    setImageResource(icon)
    contentDescription = description
    tooltipText = description
    val padding = (12 * density).toInt()
    setPadding(padding, padding, padding, padding)
    background = RippleDrawable(ColorStateList.valueOf(Color.argb(45, 220, 235, 228)), panelSurface(context, 24), null)
    setOnClickListener { action() }
    parent.addView(this, LinearLayout.LayoutParams((44 * density).toInt(), (44 * density).toInt()).apply {
        marginStart = (4 * density).toInt()
    })
}
