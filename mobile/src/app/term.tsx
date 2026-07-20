// Terminal screen — WebView on the box's /static/term.html (our own xterm.js
// client; the session token doubles as the gate cookie), plus a native key
// bar that rides above the iOS keyboard: the thing a browser can never give.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { WebView } from 'react-native-webview';
import * as Clipboard from 'expo-clipboard';
import { termUrl } from '@/lib/api';
import { Box, getBox } from '@/lib/boxes';
import { C } from '@/lib/theme';

const KEYS: Array<{ label: string; key: string; wide?: boolean }> = [
  { label: '↑', key: 'up' }, { label: '↓', key: 'down' },
  { label: '←', key: 'left' }, { label: '→', key: 'right' },
  { label: 'Esc', key: 'esc' }, { label: '⇥', key: 'tab' },
  { label: '⇧⇥', key: 'btab', wide: true },
  { label: '^C', key: 'ctrl-c' }, { label: '⏎', key: 'enter' },
];

export default function Term() {
  const { box: boxId, project, name } =
    useLocalSearchParams<{ box: string; project: string; name: string }>();
  const [box, setBox] = useState<Box | null>(null);
  const [status, setStatus] = useState<'connecting' | 'up' | 'down'>('connecting');
  const web = useRef<WebView>(null);

  useEffect(() => { void getBox(boxId).then((b) => setBox(b ?? null)); }, [boxId]);

  const js = useCallback((code: string) => {
    web.current?.injectJavaScript(`window.TC && (${code}); true;`);
  }, []);

  const paste = async () => {
    const t = await Clipboard.getStringAsync();
    if (t) js(`TC.paste(${JSON.stringify(t)})`);
  };

  if (!box) return <View style={s.root} />;

  return (
    <View style={s.root}>
      <Stack.Screen options={{
        title: name ?? project,
        headerRight: () => (
          <View style={[s.dot, {
            backgroundColor:
              status === 'up' ? C.green : status === 'down' ? C.red : C.amber,
          }]} />
        ),
      }} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <WebView
          ref={web}
          source={{ uri: termUrl(box, project) }}
          style={s.web}
          originWhitelist={['https://*', 'http://*']}
          keyboardDisplayRequiresUserAction={false}
          hideKeyboardAccessoryView
          allowsLinkPreview={false}
          setSupportMultipleWindows={false}
          onMessage={(ev) => {
            try {
              const m = JSON.parse(ev.nativeEvent.data);
              if (m.type === 'connected') setStatus('up');
              else if (m.type === 'disconnected') setStatus('connecting');
              else if (m.type === 'failed') setStatus('down');
              else if (m.type === 'selection' && m.text) {
                void Clipboard.setStringAsync(m.text);   // copy-on-select
              }
            } catch { /* not ours */ }
          }}
        />
        <ScrollView
          horizontal keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
          style={s.bar} contentContainerStyle={s.barInner}
        >
          {KEYS.map((k) => (
            <Pressable key={k.key} style={[s.kbtn, k.wide && s.wide]}
              onPress={() => js(`TC.key(${JSON.stringify(k.key)})`)}>
              <Text style={s.klabel}>{k.label}</Text>
            </Pressable>
          ))}
          <View style={s.sep} />
          <Pressable style={[s.kbtn, s.wide]} onPress={paste}>
            <Text style={s.klabel}>📋 Paste</Text>
          </Pressable>
          <Pressable style={[s.kbtn, s.wide]} onPress={() => js('TC.blurKeyboard()')}>
            <Text style={s.klabel}>⌨ Hide</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  web: { flex: 1, backgroundColor: '#000' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  bar: {
    flexGrow: 0, backgroundColor: C.panel,
    borderTopWidth: 1, borderTopColor: C.border,
  },
  barInner: { padding: 6, gap: 6, alignItems: 'center' },
  kbtn: {
    minWidth: 44, height: 40, borderRadius: 8, paddingHorizontal: 10,
    backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border,
    alignItems: 'center', justifyContent: 'center',
  },
  wide: { paddingHorizontal: 14 },
  klabel: { color: C.text, fontSize: 14 },
  sep: { width: 1, height: 24, backgroundColor: C.border, marginHorizontal: 4 },
});
