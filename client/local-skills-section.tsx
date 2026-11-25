import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc, useTranslation, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { inventoryListRpc, inventoryRescanRpc } from "../shared/rpc";
import type { LocalInventoryView } from "../shared/inventory";
import { messages } from "./messages";
import { displayInventoryRows } from "./local-skills-view";

type Theme = PluginSurfaceProps["theme"];

function useStyles(theme: Theme) {
  return useMemo(
    () =>
      StyleSheet.create({
        card: {
          gap: 12,
          padding: 20,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
        },
        title: { color: theme.colors.foreground, fontSize: 20, fontWeight: "600" },
        text: { color: theme.colors.foreground },
        muted: { color: theme.colors.foregroundMuted },
        error: { color: theme.colors.statusDanger },
        primary: {
          padding: 12,
          borderRadius: 8,
          alignSelf: "flex-start",
          backgroundColor: theme.colors.accent,
        },
        primaryDisabled: {
          padding: 12,
          borderRadius: 8,
          alignSelf: "flex-start",
          backgroundColor: theme.colors.accent,
          opacity: 0.5,
        },
        primaryText: { color: theme.colors.accentForeground, fontWeight: "600" },
        row: { gap: 4, paddingVertical: 8, borderTopWidth: 1, borderTopColor: theme.colors.border },
        code: { color: theme.colors.foreground, fontFamily: "monospace", fontSize: 12 },
      }),
    [theme],
  );
}

export function LocalSkillsSection({ theme, sessionKey }: { theme: Theme; sessionKey: string }) {
  const { t, locale } = useTranslation(messages);
  const styles = useStyles(theme);
  const queryClient = useQueryClient();
  const list = useRpc(inventoryListRpc);
  const rescan = useRpc(inventoryRescanRpc);
  const [busy, setBusy] = useState(false);
  const inventoryKey = useMemo(() => ["local-inventory", sessionKey] as const, [sessionKey]);
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;

  const query = useQuery({
    queryKey: inventoryKey,
    queryFn: () => list({}),
  });

  const runRescan = useCallback(async () => {
    const capturedSessionKey = sessionKeyRef.current;
    setBusy(true);
    try {
      await queryClient.cancelQueries({ queryKey: inventoryKey });
      if (sessionKeyRef.current !== capturedSessionKey) return;
      const next = await rescan({});
      if (sessionKeyRef.current !== capturedSessionKey) return;
      queryClient.setQueryData(inventoryKey, next);
    } catch {
      if (sessionKeyRef.current !== capturedSessionKey) return;
      const failed: LocalInventoryView = {
        state: "connected",
        scanning: false,
        items: [],
        error: "bad_response",
      };
      queryClient.setQueryData(inventoryKey, failed);
    } finally {
      setBusy(false);
    }
  }, [inventoryKey, queryClient, rescan]);

  const view = query.data;
  if (view?.state === "signed_out") return null;

  const rows =
    view?.state === "connected"
      ? displayInventoryRows(view.items, {
          harness: (id) => t(`harness.${id}`),
          source: (source) => t(`inventorySources.${source}`),
        })
      : [];
  const error = view?.state === "connected" ? view.error : query.isError ? "bad_response" : undefined;
  const scanning = busy || view?.state === "connected" && view.scanning || query.isFetching;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{t("localSkillsTitle")}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("localSkillsRescan")}
        disabled={scanning}
        onPress={() => void runRescan()}
        style={scanning ? styles.primaryDisabled : styles.primary}
      >
        <Text style={styles.primaryText}>{t("localSkillsRescan")}</Text>
      </Pressable>
      {scanning ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <ActivityIndicator />
          <Text style={styles.muted}>{t("localSkillsScanning")}</Text>
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{t(`inventoryErrors.${error}`)}</Text> : null}
      {!error && rows.length === 0 && !scanning ? (
        <Text style={styles.muted}>{t("localSkillsEmpty")}</Text>
      ) : null}
      {rows.map((row) => (
        <View key={`${row.rootKind}/${row.relativePath}`} style={styles.row}>
          <Text style={styles.text}>{row.name}</Text>
          <Text style={styles.muted}>
            {t("localSkillsTool")}: {row.harnessLabel}
          </Text>
          <Text style={styles.muted}>
            {t("localSkillsSource")}: {row.sourceLabel}
          </Text>
          <Text style={styles.code}>
            {row.rootKind} {row.relativePath}
          </Text>
          <Text style={styles.code}>{row.hashPrefix}</Text>
          <Text style={styles.muted}>{new Date(row.reportedAtMs).toLocaleString(locale)}</Text>
        </View>
      ))}
    </View>
  );
}
