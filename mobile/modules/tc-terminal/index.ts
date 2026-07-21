// JS surface for the native SwiftTerm module. Loaded defensively: binaries
// built before this module existed (or non-iOS platforms) simply get null,
// and the app falls back to the WebView terminal.
import { requireNativeModule, requireNativeViewManager } from 'expo-modules-core';
import type * as React from 'react';
import type { ViewProps } from 'react-native';

export type TCStatus = 'up' | 'connecting' | 'down';

export type TCTerminalViewProps = ViewProps & {
  sessionKey: string;
  endpoint: string;
  fontSize?: number;
  onStatus?: (e: { nativeEvent: { status: TCStatus } }) => void;
};

type TCTerminalNative = {
  send(key: string, text: string): void;
  getSelection(key: string): Promise<string>;
  disconnect(key: string): void;
  disconnectAll(): void;
};

let view: React.ComponentType<TCTerminalViewProps> | null = null;
let mod: TCTerminalNative | null = null;
try {
  mod = requireNativeModule<TCTerminalNative>('TCTerminal');
  view = requireNativeViewManager<TCTerminalViewProps>('TCTerminal');
} catch {
  // native module not present in this binary
}

export const TCTerminalView = view;
export const TCTerminal = mod;
