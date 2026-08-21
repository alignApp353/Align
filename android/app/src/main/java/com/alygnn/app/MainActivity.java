package com.alygnn.app;

import android.os.Bundle;

import androidx.appcompat.app.AppCompatDelegate;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Apply the phone's Light/Dark setting before Capacitor creates
        // the WebView. This fixes the first cold-start page opening light
        // and only switching to dark after navigating.
        AppCompatDelegate.setDefaultNightMode(
            AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
        );

        super.onCreate(savedInstanceState);
    }
}
