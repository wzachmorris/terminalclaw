// JS surface for the native selectable-text module. Loaded defensively like
// tc-terminal: binaries built before this module existed (or non-iOS
// platforms) get null and the chat falls back to RN <Text selectable>.
import { requireNativeModule, requireNativeViewManager } from 'expo-modules-core';
import * as React from 'react';
import { useState } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

type NativeProps = {
  text: string;
  fontSize?: number;
  color?: string;
  runsJson?: string;
  onSize?: (e: { nativeEvent: { height: number } }) => void;
  style?: StyleProp<ViewStyle>;
};

// style runs over `text` (UTF-16 offsets) — see lib/mdstyle.ts
export type SelRun = {
  s: number; l: number;
  b?: boolean; i?: boolean; u?: boolean; c?: string; bg?: string;
};

let Native: React.ComponentType<NativeProps> | null = null;
try {
  // requireNativeViewManager resolves lazily and NEVER throws — probing the
  // module registry is what actually detects a binary without the native
  // side (otherwise every bubble renders as a red "Unimplemented component")
  requireNativeModule('TCSelText');
  Native = requireNativeViewManager<NativeProps>('TCSelText');
} catch {
  // native module not present in this binary
}

export const selTextAvailable = !!Native;

// Native measures the text at its laid-out width and reports the real height
// via onSize; until that lands we estimate from length so long messages
// don't mount at 0 height and make the inverted list jump.
export function SelText({ text, fontSize = 12, color = '#e6edf3', runs, style }: {
  text: string; fontSize?: number; color?: string; runs?: SelRun[];
  style?: StyleProp<ViewStyle>;
}) {
  const [h, setH] = useState(0);
  if (!Native) return null;
  const lineH = Math.ceil(fontSize * 1.35);
  const est = Math.max(lineH, Math.ceil(text.length / 40) * lineH);
  return (
    <Native
      text={text}
      fontSize={fontSize}
      color={color}
      runsJson={runs && runs.length ? JSON.stringify(runs) : ''}
      style={[style, { height: h || est }]}
      onSize={(e) => setH(e.nativeEvent.height)}
    />
  );
}
