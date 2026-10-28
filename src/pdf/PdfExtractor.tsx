// Hidden WebView running a fully inlined pdf.js to pull text out of PDFs on-device.
// The page has a strict CSP (no network) and loads nothing from the internet.
import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
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
  const [gen, setGen] = useState(0); // bumped to start a fresh reader after its renderer died

  useImperativeHandle(ref, () => ({
    extract: async (base64, onProgress) => {
      if (!ready.current) {
        await new Promise<void>((res, rej) => {
          waiters.current.push(res);
          setTimeout(() => rej(new Error('PDF reader did not start')), 20000);
        });
      }
      if (!web.current) throw new Error('PDF reader is not ready. Please try again.');
      const id = Math.random().toString(36).slice(2);
      return new Promise<string[]>((resolve, reject) => {
        // A reader that stops answering must not hold up every later import: give up after 90 s without progress.
        let timer: any = null;
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (!pending.current[id]) return;
            delete pending.current[id];
            reject(new Error('The PDF reader stopped responding. Try again, or try a smaller PDF.'));
          }, 90000);
        };
        const done = <T,>(fn: (v: T) => void) => (v: T) => {
          clearTimeout(timer);
          fn(v);
        };
        pending.current[id] = {
          resolve: done(resolve),
          reject: done(reject),
          onProgress: (p, t) => {
            arm();
            onProgress?.(p, t);
          },
        };
        arm();
        web.current?.postMessage(JSON.stringify({ cmd: 'extract', id, data: base64 }));
      });
    },
  }));

  return (
    <View style={{ width: 1, height: 1, opacity: 0, position: 'absolute' }} pointerEvents="none">
      <WebView
        key={gen}
        ref={web}
        originWhitelist={['about:blank', 'data:*']}
        source={{ html: PDF_HTML, baseUrl: 'about:blank' }}
        javaScriptEnabled
        domStorageEnabled={false}
        allowFileAccess={false}
        cacheEnabled={false}
        onShouldStartLoadWithRequest={(req) => req.url === 'about:blank' || req.url.startsWith('data:')}
        // Android kills the whole app if a WebView's renderer dies (e.g. a huge PDF) and nobody handles it.
        // Handle it: fail the current PDF with a clear message and start a fresh reader.
        onRenderProcessGone={() => {
          ready.current = false;
          const all = pending.current;
          pending.current = {};
          Object.values(all).forEach((p) => p.reject(new Error('This PDF was too big for the phone to read. Try a smaller PDF, or snap photos of the pages.')));
          setGen((g) => g + 1);
        }}
        onContentProcessDidTerminate={() => {
          ready.current = false;
          const all = pending.current;
          pending.current = {};
          Object.values(all).forEach((p) => p.reject(new Error('The PDF reader closed unexpectedly. Please try again.')));
          setGen((g) => g + 1);
        }}
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
