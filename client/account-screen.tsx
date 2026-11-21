import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  openExternalUrl,
  useRpc,
  useSettings,
  useTranslation,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import {
  ScrollView,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
  copyText,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { loginRpc, logoutRpc, pollRpc, statusRpc } from "../shared/rpc";
import { connection, mcp } from "../shared/settings";
import type { AccountStatus } from "../shared/status";
import { mcpEnabled, refetchIntervalFor } from "../shared/view";
import { messages } from "./messages";

const STATUS_KEY = ["account-status"];

type Theme = PluginSurfaceProps["theme"];

function useStyles(theme: Theme, compact: boolean) {
  return useMemo(() => {
    const button = { padding: 12, borderRadius: 8, alignSelf: "flex-start" as const };
    return StyleSheet.create({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: {
        padding: compact ? 16 : 24,
        gap: 20,
        width: "100%",
        maxWidth: 760,
        alignSelf: "center",
      },
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
      link: { color: theme.colors.accent },
      primary: { ...button, backgroundColor: theme.colors.accent },
      primaryDisabled: { ...button, backgroundColor: theme.colors.accent, opacity: 0.5 },
      primaryText: { color: theme.colors.accentForeground, fontWeight: "600" },
      secondary: { ...button, borderWidth: 1, borderColor: theme.colors.border },
      row: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
      banner: {
        gap: 8,
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.statusWarning,
        backgroundColor: theme.colors.surface2,
      },
      pill: {
        alignSelf: "flex-start",
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.statusWarning,
      },
      pillText: { color: theme.colors.statusWarning },
      section: { gap: 8 },
      selectable: { color: theme.colors.foreground, fontFamily: "monospace" },
    });
  }, [theme, compact]);
}
type Styles = ReturnType<typeof useStyles>;

interface Actions {
  login(): Promise<void>;
  logout(force?: boolean): Promise<void>;
  openBrowser(url: string): Promise<boolean>;
  busy: boolean;
  // The browser could not be opened after login, so the link must be visible at once.
  browserFailed: boolean;
}

function Button({
  label,
  onPress,
  styles,
  kind = "primary",
  disabled = false,
}: {
  label: string;
  onPress(): void;
  styles: Styles;
  kind?: "primary" | "secondary";
  disabled?: boolean;
}) {
  const style =
    kind === "secondary" ? styles.secondary : disabled ? styles.primaryDisabled : styles.primary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={style}
    >
      <Text style={kind === "secondary" ? styles.text : styles.primaryText}>{label}</Text>
    </Pressable>
  );
}

function TextLink({ label, onPress, styles }: { label: string; onPress(): void; styles: Styles }) {
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={label} onPress={onPress}>
      <Text style={styles.link}>{label}</Text>
    </Pressable>
  );
}

function SetupSummary({
  setup,
  styles,
}: {
  setup: NonNullable<AccountStatus["setup"]>;
  styles: Styles;
}) {
  const { t } = useTranslation(messages);
  return (
    <View style={styles.section}>
      <Text style={styles.text}>{t("setupTitle")}</Text>
      {setup.running ? <Text style={styles.muted}>{t("setupRunning")}</Text> : null}
      {setup.error ? <Text style={styles.error}>{t(`setupErrors.${setup.error}`)}</Text> : null}
      {!setup.running && !setup.error && setup.harnesses.length === 0 ? (
        <Text style={styles.muted}>{t("setupNone")}</Text>
      ) : null}
      {setup.harnesses.map((item) => (
        <SettingsRow key={item.id} label={t(`harness.${item.id}`)}>
          <Text style={item.state === "failed" ? styles.error : styles.text}>
            {t(`harnessState.${item.state}`)}
          </Text>
          {item.error ? <Text style={styles.muted}>{t(`harnessErrors.${item.error}`)}</Text> : null}
        </SettingsRow>
      ))}
      {!setup.running && !setup.error ? <Text style={styles.muted}>{t("setupLater")}</Text> : null}
    </View>
  );
}

function RemovalNotice({
  removal,
  removing,
  styles,
}: {
  removal?: AccountStatus["removal"];
  removing?: boolean;
  styles: Styles;
}) {
  const { t } = useTranslation(messages);
  if (removing || !removal) {
    return (
      <View style={styles.banner}>
        <Text style={styles.muted}>{t("removalRunning")}</Text>
      </View>
    );
  }
  return (
    <View style={styles.banner}>
      <Text style={styles.text}>{t("removalTitle")}</Text>
      <Text style={styles.muted}>{t("removalLead")}</Text>
      {removal.map((item) => (
        <SettingsRow key={item.id} label={t(`harness.${item.id}`)}>
          <Text style={styles.muted}>{t(`removalResults.${item.result}`)}</Text>
        </SettingsRow>
      ))}
    </View>
  );
}

function LoginCard({
  status,
  actions,
  styles,
}: {
  status: Extract<AccountStatus, { state: "signed_out" | "expired" }>;
  actions: Actions;
  styles: Styles;
}) {
  const { t } = useTranslation(messages);
  const reason = status.state === "signed_out" ? status.reason : undefined;
  const blocked = reason === "not_configured" || reason === "invalid_base_url";
  return (
    <View style={styles.card}>
      <Text style={styles.title}>
        {status.state === "expired" ? t("expiredTitle") : t("loginTitle")}
      </Text>
      <Text style={styles.muted}>{t("loginLead")}</Text>
      {reason ? <Text style={styles.muted}>{t(`reasons.${reason}`)}</Text> : null}
      {status.lastError ? <Text style={styles.error}>{t(`errors.${status.lastError}`)}</Text> : null}
      {status.removing || status.removal ? (
        <RemovalNotice removal={status.removal} removing={status.removing} styles={styles} />
      ) : null}
      <Button
        label={t("loginBtn")}
        onPress={actions.login}
        styles={styles}
        disabled={actions.busy || blocked}
      />
      <Text style={styles.muted}>{t("loginNote")}</Text>
    </View>
  );
}

function WaitingCard({
  status,
  actions,
  styles,
}: {
  status: Extract<AccountStatus, { state: "waiting_browser" }>;
  actions: Actions;
  styles: Styles;
}) {
  const { t, locale } = useTranslation(messages);
  const toast = useToast();
  const [showLink, setShowLink] = useState(actions.browserFailed);
  useEffect(() => {
    if (actions.browserFailed) setShowLink(true);
  }, [actions.browserFailed]);
  const toggleLink = useCallback(() => setShowLink((value) => !value), []);
  const openAgain = useCallback(async () => {
    if (!(await actions.openBrowser(status.verificationUri))) setShowLink(true);
  }, [actions, status.verificationUri]);
  const copy = useCallback(async () => {
    try {
      await copyText(status.verificationUri);
      toast.show(t("copied"), { variant: "success" });
    } catch {
      toast.error(t("copyFailed"));
    }
  }, [status.verificationUri, t, toast]);
  const cancel = useCallback(() => void actions.logout(), [actions]);
  const time = new Date(status.expiresAt).toLocaleTimeString(locale);
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{t("codeTitle")}</Text>
      <Text style={styles.muted}>{t("codeLead")}</Text>
      <Button label={t("openBrowser")} onPress={openAgain} styles={styles} />
      <TextLink label={t("noBrowser")} onPress={toggleLink} styles={styles} />
      {showLink ? (
        <View style={styles.card}>
          <Text style={styles.muted}>{t("noBrowserLead")}</Text>
          <Text selectable style={styles.selectable}>
            {status.verificationUri}
          </Text>
          <Button label={t("copyLink")} onPress={copy} styles={styles} kind="secondary" />
        </View>
      ) : null}
      <View style={styles.row}>
        <ActivityIndicator />
        <Text style={styles.muted}>{t("waiting")}</Text>
      </View>
      <Text style={styles.muted}>{t("codeExpire", { time })}</Text>
      {status.lastError ? <Text style={styles.error}>{t(`errors.${status.lastError}`)}</Text> : null}
      <TextLink label={t("cancel")} onPress={cancel} styles={styles} />
    </View>
  );
}

function PendingCard({
  status,
  actions,
  styles,
}: {
  status: Extract<AccountStatus, { state: "account_pending" }>;
  actions: Actions;
  styles: Styles;
}) {
  const { t, locale } = useTranslation(messages);
  const logout = useCallback(() => void actions.logout(), [actions]);
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{t("penTitle")}</Text>
      <Text style={styles.muted}>{t("penLead")}</Text>
      {status.email ? (
        <SettingsRow label={t("penEmail")}>
          <Text style={styles.text}>{status.email}</Text>
        </SettingsRow>
      ) : null}
      <SettingsRow label={t("penStatus")}>
        <View style={styles.pill}>
          <Text style={styles.pillText}>{t("pending")}</Text>
        </View>
      </SettingsRow>
      <SettingsRow label={t("penSince")}>
        <Text style={styles.text}>{new Date(status.requestedAt).toLocaleString(locale)}</Text>
      </SettingsRow>
      {status.lastError ? <Text style={styles.error}>{t(`errors.${status.lastError}`)}</Text> : null}
      <View style={styles.row}>
        <ActivityIndicator />
        <Text style={styles.muted}>{t("penAuto")}</Text>
      </View>
      <TextLink label={t("logout")} onPress={logout} styles={styles} />
    </View>
  );
}

function ConnectedCard({
  status,
  actions,
  styles,
}: {
  status: Extract<AccountStatus, { state: "connected" }>;
  actions: Actions;
  styles: Styles;
}) {
  const { t, locale } = useTranslation(messages);
  const date = new Date(status.expiresAt).toLocaleDateString(locale);
  const logout = useCallback(() => void actions.logout(), [actions]);
  const removeAnyway = useCallback(() => void actions.logout(true), [actions]);
  const teams = status.teams.map((team) => (team.role ? `${team.name} · ${team.role}` : team.name));
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{t("okTitle")}</Text>
      {status.renewDue ? (
        <View style={styles.banner}>
          <Text style={styles.text}>{t("renewBanner", { date })}</Text>
          <Button label={t("renewBtn")} onPress={actions.login} styles={styles} disabled={actions.busy} />
        </View>
      ) : null}
      <SettingsRow label={t("penEmail")}>
        <Text style={styles.text}>{status.account.email ?? status.account.username}</Text>
      </SettingsRow>
      {teams.length > 0 ? (
        <SettingsRow label={t("okTeam")}>
          <Text style={styles.text}>{teams.join(", ")}</Text>
        </SettingsRow>
      ) : null}
      <SettingsRow label={t("okDevice")}>
        <Text style={styles.text}>{status.deviceName}</Text>
      </SettingsRow>
      <SettingsRow label={t("okExp")}>
        <Text style={styles.text}>{t("okExpVal", { date })}</Text>
      </SettingsRow>
      {status.lastError === "logout_unreachable" ? (
        <View style={styles.banner}>
          <Text style={styles.text}>{t("logoutUnreachable", { date })}</Text>
          <Button label={t("removeAnyway")} onPress={removeAnyway} styles={styles} kind="secondary" />
        </View>
      ) : status.lastError ? (
        <Text style={styles.error}>{t(`errors.${status.lastError}`)}</Text>
      ) : null}
      <McpSwitch styles={styles} />
      {status.setup ? <SetupSummary setup={status.setup} styles={styles} /> : null}
      <TextLink label={t("logout")} onPress={logout} styles={styles} />
    </View>
  );
}

function ConnectionForm({
  settings,
  onSaved,
}: {
  settings: Extract<ReturnType<typeof useSettings<typeof connection.schema>>, { status: "ready" }>;
  onSaved(): void;
}) {
  const { t } = useTranslation(messages);
  // Keep the revision the draft started from, so another client's save produces a conflict.
  const [draft, setDraft] = useState(() => ({
    values: settings.values,
    revision: settings.revision,
  }));
  const setField = useCallback(
    (field: "baseUrl" | "deviceName" | "instanceId") => (text: string) =>
      setDraft((current) => ({ ...current, values: { ...current.values, [field]: text } })),
    [],
  );
  const onBaseUrl = useMemo(() => setField("baseUrl"), [setField]);
  const onDeviceName = useMemo(() => setField("deviceName"), [setField]);
  const onInstanceId = useMemo(() => setField("instanceId"), [setField]);
  const save = useCallback(async () => {
    if (await settings.save(draft.values, draft.revision)) onSaved();
  }, [settings, draft, onSaved]);
  return (
    <SettingsSection title={t("connTitle")}>
      <SettingsCard>
        <SettingsInput
          label={t("baseUrl")}
          hint={t("baseUrlHint")}
          initialValue={draft.values.baseUrl}
          onChangeText={onBaseUrl}
          disabled={settings.saving}
          error={settings.saveError}
        />
        <SettingsInput
          label={t("deviceName")}
          hint={t("deviceNameHint")}
          initialValue={draft.values.deviceName}
          onChangeText={onDeviceName}
          disabled={settings.saving}
        />
        <SettingsInput
          label={t("instanceId")}
          initialValue={draft.values.instanceId}
          onChangeText={onInstanceId}
          disabled={settings.saving}
        />
        <SettingsAction
          label={t("save")}
          actionLabel={t("save")}
          disabled={settings.saving}
          onPress={save}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function McpSwitch({ styles }: { styles: Styles }) {
  const { t } = useTranslation(messages);
  const settings = useSettings(mcp);
  const ready = settings.status === "ready";
  // A document that is not ready counts as off: the server attaches nothing for it.
  const enabled = mcpEnabled(settings);
  const toggle = useCallback(
    (value: boolean) => {
      if (settings.status === "ready") void settings.save({ enabled: value }, settings.revision);
    },
    [settings],
  );
  if (settings.status === "loading") return null;
  return (
    <View style={styles.section}>
      <SettingsSwitch
        label={t("mcpSwitch")}
        value={enabled}
        onValueChange={toggle}
        disabled={!ready || settings.saving}
        error={ready ? settings.saveError : settings.error}
      />
      <Text style={styles.muted}>{t(ready ? (enabled ? "mcpOn" : "mcpOff") : "mcpInvalid")}</Text>
      {settings.status === "invalid" ? (
        <SettingsAction label={t("restoreDefaults")} actionLabel={t("reset")} onPress={settings.reset} />
      ) : null}
    </View>
  );
}

function ConnectionSection({ onSaved, styles }: { onSaved(): void; styles: Styles }) {
  const { t } = useTranslation(messages);
  const settings = useSettings(connection);
  if (settings.status === "loading") return null;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Agent-Memory">
        <Text style={styles.error}>{settings.error}</Text>
        <SettingsAction label={t("tryAgain")} actionLabel={t("reload")} onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction label={t("restoreDefaults")} actionLabel={t("reset")} onPress={settings.reset} />
        ) : null}
      </SettingsSection>
    );
  }
  return <ConnectionForm key={settings.revision} settings={settings} onSaved={onSaved} />;
}

export function AccountScreen({ theme, layout }: PluginSurfaceProps) {
  const { t } = useTranslation(messages);
  const toast = useToast();
  const queryClient = useQueryClient();
  const styles = useStyles(theme, layout.compact);
  const getStatus = useRpc(statusRpc);
  const poll = useRpc(pollRpc);
  const login = useRpc(loginRpc);
  const logout = useRpc(logoutRpc);
  const [busy, setBusy] = useState(false);
  const [browserFailed, setBrowserFailed] = useState(false);

  const query = useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => {
      const current = queryClient.getQueryData<AccountStatus>(STATUS_KEY);
      const settling = current?.state === "waiting_browser" || current?.state === "account_pending";
      return settling ? poll({}) : getStatus({});
    },
    refetchInterval: (q) => refetchIntervalFor(q.state.data),
  });

  const store = useCallback(
    async (status: AccountStatus) => {
      // An older in-flight status reply must not overwrite this newer result.
      await queryClient.cancelQueries({ queryKey: STATUS_KEY });
      queryClient.setQueryData(STATUS_KEY, status);
    },
    [queryClient],
  );

  const openBrowser = useCallback(async (url: string) => {
    try {
      await openExternalUrl(url);
      return true;
    } catch {
      return false;
    }
  }, []);

  const actions = useMemo<Actions>(
    () => ({
      busy,
      browserFailed,
      openBrowser,
      async login() {
        setBusy(true);
        try {
          setBrowserFailed(false);
          const next = await login({});
          await store(next);
          // Open the browser inside the press handler: hosts only allow it from a user action.
          if (next.state === "waiting_browser") {
            setBrowserFailed(!(await openBrowser(next.verificationUri)));
          }
        } catch {
          toast.error(t("errors.bad_response"));
        } finally {
          setBusy(false);
        }
      },
      async logout(force = false) {
        setBusy(true);
        try {
          const next = await logout({ force });
          setBrowserFailed(false);
          await store(next);
        } catch {
          toast.error(t("errors.bad_response"));
        } finally {
          setBusy(false);
        }
      },
    }),
    [busy, browserFailed, openBrowser, login, logout, store, toast, t],
  );

  const refresh = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: STATUS_KEY }),
    [queryClient],
  );

  const status = query.data;
  let card = null;
  if (status) {
    switch (status.state) {
      case "waiting_browser":
        card = <WaitingCard status={status} actions={actions} styles={styles} />;
        break;
      case "account_pending":
        card = <PendingCard status={status} actions={actions} styles={styles} />;
        break;
      case "connected":
        card = <ConnectedCard status={status} actions={actions} styles={styles} />;
        break;
      default:
        card = <LoginCard status={status} actions={actions} styles={styles} />;
    }
  } else if (query.isError) {
    card = (
      <View style={styles.card}>
        <Text style={styles.error}>{t("errors.bad_response")}</Text>
      </View>
    );
  } else {
    card = <ActivityIndicator />;
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {card}
      <ConnectionSection onSaved={refresh} styles={styles} />
    </ScrollView>
  );
}
