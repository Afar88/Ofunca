// Hidden WebView running a fully inlined pdf.js to pull text out of PDFs on-device.
// The page has a strict CSP (no network) and loads nothing from the internet.
import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import { PDF_HTML } from './pdfHtml.generated';

export type PdfExtractorHandle = {
  extract: (base64: string, onProgress?: (page: number, total: number) => void) => Promise<string[]>;
};

type Pending = { resolve: (p: string[]) => void; reject: (e: Error) => void; onProgress?: (p: number, t: number) => void };

export const PdfExtractor = forwardRef<PdfExtractorHandle>(function PdfExtractor(_props, ref) {
  const web = useRef<WebView>(null);
  const pending = useRef<Record<string, Pending>>({});
  const ready = useRef(false);
  const waiters = useRef<(() => void)[]>([]);

  useImperativeHandle(ref, () => ({
    extract: async (base64, onProgress) => {
      if (!ready.current) {
        await new Promise<void>((res, rej) => {
          waiters.current.push(res);
          setTimeout(() => rej(new Error('PDF reader did not start')), 20000);
        });
      }
      const id = Math.random().toString(36).slice(2);
      return new Promise<string[]>((resolve, reject) => {
        pending.current[id] = { resolve, reject, onProgress };
        web.current?.postMessage(JSON.stringify({ cmd: 'extract', id, data: base64 }));
      });
    },
  }));

  return (
    <View style={{ width: 1, height: 1, opacity: 0, position: 'absolute' }} pointerEvents="none">
      <WebView
        ref={web}
        originWhitelist={['about:blank', 'data:*']}
        source={{ html: PDF_HTML, baseUrl: 'about:blank' }}
        javaScriptEnabled
        domStorageEnabled={false}
        allowFileAccess={false}
        cacheEnabled={false}
        onShouldStartLoadWithRequest={(req) => req.url === 'about:blank' || req.url.startsWith('data:')}
        onMessage={(ev) => {
          let msg: any;
          try {
            msg = JSON.parse(ev.nativeEvent.data);
          } catch {
            return;
          }
          if (msg.type === 'ready') {
            ready.current = true;
            waiters.current.splice(0).forEach((w) => w());
            return;
          }
          const p = pending.current[msg.id];
          if (!p) return;
          if (msg.type === 'progress') p.onProgress?.(msg.page, msg.total);
          else if (msg.type === 'done') {
            delete pending.current[msg.id];
            p.resolve(msg.pages as string[]);
          } else if (msg.type === 'error') {
            delete pending.current[msg.id];
            p.reject(new Error(msg.message));
          }
        }}
      />
    </View>
  );
});
