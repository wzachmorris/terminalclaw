// Machines screen — every box in one place. Add a box once (name + URL +
// gate password); the 30-day token is stored in the keychain and refreshed
// by logging in again whenever it dies.
import { useCallback, useState } from 'react';
import {
  Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { router, Stack, useFocusEffect } from 'expo-router';
import { login } from '@/lib/api';
import { Box, deleteBox, loadBoxes, normalizeUrl, tokenAlive, upsertBox } from '@/lib/boxes';
import { C } from '@/lib/theme';

export default function Machines() {
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Box | null>(null);

  useFocusEffect(useCallback(() => { void loadBoxes().then(setBoxes); }, []));

  const remove = (b: Box) =>
    Alert.alert(`Remove ${b.name}?`, 'Only removes it from this app.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: () => void deleteBox(b.id).then(loadBoxes).then(setBoxes),
      },
    ]);

  return (
    <View style={s.root}>
      <Stack.Screen options={{ title: 'TerminalClaw' }} />
      <FlatList
        data={boxes}
        keyExtractor={(b) => b.id}
        contentContainerStyle={{ padding: 12 }}
        ListEmptyComponent={
          <Text style={s.empty}>
            No machines yet.{'\n'}Add one with its dashboard URL and gate password.
          </Text>
        }
        renderItem={({ item }) => {
          const alive = tokenAlive(item);
          const days = Math.max(0, Math.floor((item.expiresAt - Date.now()) / 86_400_000));
          return (
            <Pressable
              style={s.card}
              onPress={() => alive ? router.push(`/box/${item.id}`) : setEditing(item)}
              onLongPress={() => remove(item)}
            >
              <View style={[s.dot, { backgroundColor: alive ? C.green : C.amber }]} />
              <View style={{ flex: 1 }}>
                <Text style={s.name}>{item.name}</Text>
                <Text style={s.sub}>{item.url.replace(/^https?:\/\//, '')}</Text>
              </View>
              <Text style={s.status}>
                {alive ? `${days}d` : 'login'}
              </Text>
            </Pressable>
          );
        }}
      />
      <Pressable style={s.add} onPress={() => setAdding(true)}>
        <Text style={s.addText}>+ Add machine</Text>
      </Pressable>
      {(adding || editing) && (
        <BoxForm
          box={editing}
          onDone={(saved) => {
            setAdding(false); setEditing(null);
            if (saved) void loadBoxes().then(setBoxes);
          }}
        />
      )}
    </View>
  );
}

function BoxForm({ box, onDone }: { box: Box | null; onDone: (saved: boolean) => void }) {
  const [name, setName] = useState(box?.name ?? '');
  const [url, setUrl] = useState(box?.url ?? 'https://');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    const u = normalizeUrl(url);
    if (!name.trim() || u.length < 12) { setErr('Name and URL are required.'); return; }
    setBusy(true); setErr('');
    try {
      const { token, expiresAt } = await login(u, password);
      await upsertBox({
        id: box?.id ?? `${Date.now()}`,
        name: name.trim(), url: u, token, expiresAt,
      });
      onDone(true);
    } catch (e: any) {
      setErr(e?.status === 401 ? 'Wrong password.'
        : e?.status === 429 ? 'Too many attempts — wait a minute.'
        : `Could not reach ${u}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal transparent animationType="fade">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={s.modalWrap}
      >
        <View style={s.modal}>
          <Text style={s.modalTitle}>{box ? `Log in to ${box.name}` : 'Add machine'}</Text>
          <TextInput
            style={s.input} placeholder="Name (e.g. minotaur)" placeholderTextColor={C.muted}
            value={name} onChangeText={setName} autoCapitalize="none" autoCorrect={false}
          />
          <TextInput
            style={s.input} placeholder="https://box.example.com" placeholderTextColor={C.muted}
            value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false}
            keyboardType="url" editable={!box}
          />
          <TextInput
            style={s.input} placeholder="Gate password" placeholderTextColor={C.muted}
            value={password} onChangeText={setPassword} secureTextEntry
            onSubmitEditing={submit}
          />
          {!!err && <Text style={s.err}>{err}</Text>}
          <View style={s.row}>
            <Pressable style={[s.btn, s.ghost]} onPress={() => onDone(false)}>
              <Text style={s.ghostText}>Cancel</Text>
            </Pressable>
            <Pressable style={s.btn} onPress={submit} disabled={busy}>
              <Text style={s.btnText}>{busy ? '…' : box ? 'Log in' : 'Add'}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  empty: { color: C.muted, textAlign: 'center', marginTop: 60, lineHeight: 22 },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.panel, borderColor: C.border, borderWidth: 1,
    borderRadius: 10, padding: 14, marginBottom: 10,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  name: { color: C.text, fontSize: 15, fontWeight: '600' },
  sub: { color: C.muted, fontSize: 12, marginTop: 2 },
  status: { color: C.muted, fontSize: 12 },
  add: {
    margin: 12, padding: 14, borderRadius: 10, borderWidth: 1,
    borderStyle: 'dashed', borderColor: C.border, alignItems: 'center',
  },
  addText: { color: C.accent, fontSize: 14 },
  modalWrap: {
    flex: 1, backgroundColor: 'rgba(0,0,0,.6)',
    justifyContent: 'center', padding: 24,
  },
  modal: {
    backgroundColor: C.panel, borderRadius: 12, padding: 18,
    borderWidth: 1, borderColor: C.border,
  },
  modalTitle: { color: C.text, fontSize: 16, fontWeight: '600', marginBottom: 12 },
  input: {
    backgroundColor: C.bg, borderColor: C.border, borderWidth: 1, borderRadius: 8,
    color: C.text, padding: 11, marginBottom: 10, fontSize: 15,
  },
  err: { color: C.red, marginBottom: 8, fontSize: 13 },
  row: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end' },
  btn: {
    backgroundColor: C.accent, borderRadius: 8,
    paddingVertical: 10, paddingHorizontal: 18,
  },
  btnText: { color: C.bg, fontWeight: '600' },
  ghost: { backgroundColor: 'transparent' },
  ghostText: { color: C.muted },
});
