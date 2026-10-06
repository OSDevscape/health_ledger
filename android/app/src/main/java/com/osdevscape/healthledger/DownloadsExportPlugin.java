package com.osdevscape.healthledger;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.PluginMethod;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name = "DownloadsExport")
public class DownloadsExportPlugin extends Plugin {

    @PluginMethod
    public void saveJson(PluginCall call) {
        String filename = call.getString(
            "filename",
            "health-ledger-backup.json"
        );
        String contents = call.getString("contents", "");

        if (contents.isEmpty()) {
            call.reject("Backup contents are empty.");
            return;
        }

        try {
            ContentValues values = new ContentValues();
            values.put(
                MediaStore.Downloads.DISPLAY_NAME,
                filename
            );
            values.put(
                MediaStore.Downloads.MIME_TYPE,
                "application/json"
            );

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                values.put(
                    MediaStore.Downloads.RELATIVE_PATH,
                    "Download/Health Ledger"
                );
                values.put(
                    MediaStore.Downloads.IS_PENDING,
                    1
                );
            }

            ContentResolver resolver =
                getContext().getContentResolver();

            Uri uri = resolver.insert(
                MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                values
            );

            if (uri == null) {
                call.reject(
                    "Android could not create a Downloads file."
                );
                return;
            }

            try (OutputStream output =
                     resolver.openOutputStream(uri)) {
                if (output == null) {
                    call.reject(
                        "Android could not open the Downloads file."
                    );
                    return;
                }

                output.write(
                    contents.getBytes(StandardCharsets.UTF_8)
                );
                output.flush();
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues published = new ContentValues();
                published.put(
                    MediaStore.Downloads.IS_PENDING,
                    0
                );
                resolver.update(uri, published, null, null);
            }

            JSObject result = new JSObject();
            result.put("uri", uri.toString());
            result.put(
                "message",
                "Backup saved to Downloads/Health Ledger."
            );

            call.resolve(result);
        } catch (Exception error) {
            call.reject(
                "Could not save the backup to Downloads.",
                error
            );
        }
    }
}