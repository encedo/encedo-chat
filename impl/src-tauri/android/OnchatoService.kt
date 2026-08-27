package com.onchato.chat

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder

/**
 * The service that keeps onchato reachable.
 *
 * ## Why a messenger needs this and most apps do not
 *
 * onchato has no store-and-forward. Nothing holds a message while the recipient
 * is away — the two clients meet on a topic, or the conversation does not
 * happen. "Online" is therefore not a status the product displays, it is a
 * process that is running and subscribed, and Android freezes processes that
 * are not doing anything it can see (Doze, App Standby). A phone in a pocket
 * is, without this, a person nobody can reach.
 *
 * The usual answer — push through FCM — is not available to us and not wanted:
 * it would put a Google server between two people whose whole arrangement is
 * that no server sits between them. So the app stays awake itself, and pays the
 * honest price for it: a notification that says so, and battery.
 *
 * ## The details that are decisions
 *
 * - **`specialUse`**, not `dataSync`. `dataSync` is capped (Android 15 gives it
 *   about six hours a day and then stops it), which would end a conversation
 *   silently in the evening. `specialUse` describes what this is — a peer-to-peer
 *   client with no push server — and Play requires that justification in
 *   writing, which is the right place for it.
 * - **No message text, ever.** This notification says the app is running and
 *   nothing else. Message notifications are a separate, deliberate feature
 *   (`lib/notify.ts`) with three modes and no body in any of them.
 * - **The title is the app's name and there is no sentence** — the app's
 *   language lives in the webview, and a service that hardcoded Polish or
 *   English would be wrong for half its users. If this ever needs a sentence,
 *   it has to come from the webview the way the desktop tray's labels do.
 * - **START_STICKY**: if Android kills us under memory pressure, come back.
 *   It is not a guarantee — some vendors ignore it — and the product should not
 *   pretend otherwise.
 */
class OnchatoService : Service() {
    companion object {
        const val CHANNEL = "onchato-presence"
        const val NOTIFICATION_ID = 1001
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        // IMPORTANCE_LOW: present in the shade, silent. This is a status, not an
        // event — the events have their own channel and their own rules.
        val channel = NotificationChannel(CHANNEL, "onchato", NotificationManager.IMPORTANCE_LOW)
        channel.setShowBadge(false)
        manager.createNotificationChannel(channel)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(this, CHANNEL)
            .setContentTitle("onchato")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        // minSdk is 34, so the typed form is always available and always
        // required — the untyped call throws on Android 14.
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        return START_STICKY
    }
}
