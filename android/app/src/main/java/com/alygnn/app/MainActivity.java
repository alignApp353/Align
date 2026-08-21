package com.alygnn.app;

import android.os.Bundle;
import android.content.res.Configuration;
import android.util.Log;
import android.util.TypedValue;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatDelegate;
import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {

        // Follow the phone's current Light / Dark appearance.
        AppCompatDelegate.setDefaultNightMode(
            AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
        );

        /*
         * IMPORTANT:
         * AndroidManifest.xml starts MainActivity with
         * AppTheme.NoActionBarLaunch, whose parent is Theme.SplashScreen.
         *
         * Calling installSplashScreen() here is what tells AndroidX to
         * replace that temporary launch theme with postSplashScreenTheme
         * (AppTheme.NoActionBar) before Capacitor creates the WebView.
         *
         * Without this call, the first WebView page can inherit the
         * light SplashScreen theme on a cold start.
         */
        SplashScreen.installSplashScreen(this);

        super.onCreate(savedInstanceState);

        int nightMode =
            getResources().getConfiguration().uiMode
            & Configuration.UI_MODE_NIGHT_MASK;

        String systemMode =
            nightMode == Configuration.UI_MODE_NIGHT_YES
                ? "DARK"
                : nightMode == Configuration.UI_MODE_NIGHT_NO
                    ? "LIGHT"
                    : "UNDEFINED";

        TypedValue isLightThemeValue = new TypedValue();
        boolean resolved =
            getTheme().resolveAttribute(
                android.R.attr.isLightTheme,
                isLightThemeValue,
                true
            );

        String isLightTheme =
            resolved
                ? String.valueOf(isLightThemeValue.data != 0)
                : "NOT_SET";

        String debugMessage =
            "Android uiMode: " + systemMode
            + " | isLightTheme: " + isLightTheme;

        Log.e("ALYGNN_THEME_DEBUG", debugMessage);

        Toast.makeText(
            this,
            debugMessage,
            Toast.LENGTH_LONG
        ).show();
    }
}
