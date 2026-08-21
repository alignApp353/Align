package com.alygnn.app;

import android.os.Bundle;

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
    }
}
