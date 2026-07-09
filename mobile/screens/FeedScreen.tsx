import { useCallback, useEffect, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { supabase } from "../lib/supabase";
import { CATEGORIES, FeedGroup, groupCategory, groupSummary } from "../lib/types";

function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 60) return `${mins} phút trước`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return `${Math.round(hours / 24)} ngày trước`;
}

// A group the user is editing the pin/note for, plus the note text in the modal.
interface PinEditor {
  group: FeedGroup;
  note: string;
  existing: boolean;
}

const PREVIEW_LINES = 3; // feed cards show a short preview; tap opens the full detail

export default function FeedScreen({ userId }: { userId: string }) {
  const [groups, setGroups] = useState<FeedGroup[]>([]);
  // group_id -> note (note may be empty string when pinned without a note)
  const [pins, setPins] = useState<Map<string, string>>(new Map());
  const [subscribed, setSubscribed] = useState<Set<string> | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<PinEditor | null>(null);
  const [saving, setSaving] = useState(false);
  // the group whose full-detail screen is open (null = feed list)
  const [detailId, setDetailId] = useState<string | null>(null);
  // selected category filter (null = "Tất cả" / show all)
  const [category, setCategory] = useState<string | null>(null);
  // feed ordering: newest-first (default) or by outlet coverage (trending)
  const [sort, setSort] = useState<"recent" | "trending">("recent");
  // group_ids the user has already opened (dimmed in the feed)
  const [reads, setReads] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setError(null);
    const [groupsRes, pinsRes, subsRes, readsRes] = await Promise.all([
      supabase
        .from("article_groups")
        .select(
          "id, title, first_seen_at, article_count, summaries(summary_vi, status, category), articles(id, title, url, source_id, published_at, sources(name))",
        )
        .order("first_seen_at", { ascending: false })
        .limit(100),
      supabase.from("pins").select("group_id, note").eq("user_id", userId),
      supabase.from("user_sources").select("source_id").eq("user_id", userId),
      supabase.from("reads").select("group_id").eq("user_id", userId),
    ]);
    if (groupsRes.error) {
      setError(groupsRes.error.message);
      return;
    }
    setGroups((groupsRes.data ?? []) as unknown as FeedGroup[]);
    setPins(new Map((pinsRes.data ?? []).map((p) => [p.group_id, p.note ?? ""])));
    setSubscribed(new Set((subsRes.data ?? []).map((s) => s.source_id)));
    setReads(new Set((readsRes.data ?? []).map((r) => r.group_id)));
  }, [userId]);

  // Open a story's detail and mark it read (optimistic; read state is
  // non-critical so a failed upsert is left un-reverted).
  function openDetail(id: string) {
    setDetailId(id);
    if (reads.has(id)) return;
    setReads((prev) => new Set(prev).add(id));
    supabase
      .from("reads")
      .upsert({ user_id: userId, group_id: id }, { onConflict: "user_id,group_id" })
      .then(({ error: e }) => e && console.warn("mark read failed:", e.message));
  }

  useEffect(() => {
    load();
  }, [load]);

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  // Tapping the star opens the editor: for an unpinned group it offers a note to
  // pin with; for a pinned group it shows the saved note to edit or lets you unpin.
  function openEditor(group: FeedGroup) {
    const existing = pins.has(group.id);
    setEditor({ group, note: pins.get(group.id) ?? "", existing });
  }

  async function savePin() {
    if (!editor) return;
    setSaving(true);
    const groupId = editor.group.id;
    const note = editor.note.trim();
    const { error: upErr } = await supabase
      .from("pins")
      .upsert({ user_id: userId, group_id: groupId, note: note || null }, { onConflict: "user_id,group_id" });
    setSaving(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setPins((prev) => new Map(prev).set(groupId, note));
    setEditor(null);
  }

  async function removePin() {
    if (!editor) return;
    setSaving(true);
    const groupId = editor.group.id;
    const { error: delErr } = await supabase
      .from("pins")
      .delete()
      .eq("user_id", userId)
      .eq("group_id", groupId);
    setSaving(false);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    setPins((prev) => {
      const next = new Map(prev);
      next.delete(groupId);
      return next;
    });
    setEditor(null);
  }

  // No subscriptions yet = show everything; otherwise only groups with at
  // least one article from a subscribed source (filtering is client-side by design).
  const subFiltered =
    !subscribed || subscribed.size === 0
      ? groups
      : groups.filter((g) => g.articles.some((a) => subscribed.has(a.source_id)));

  // Only show chips for categories actually present in the current feed, in the
  // fixed taxonomy order. Then narrow the list by the selected category (if any).
  const presentCategories = CATEGORIES.filter((c) =>
    subFiltered.some((g) => groupCategory(g) === c),
  );
  const filtered = category
    ? subFiltered.filter((g) => groupCategory(g) === category)
    : subFiltered;

  // "Nổi bật" ranks by how many outlets cover the story, then recency.
  // "Mới nhất" keeps the query's newest-first order (no client sort needed).
  const visible =
    sort === "trending"
      ? [...filtered].sort(
          (a, b) =>
            b.article_count - a.article_count ||
            Date.parse(b.first_seen_at) - Date.parse(a.first_seen_at),
        )
      : filtered;

  // Resolve the open detail from the live list so it reflects refreshes/pin edits.
  const detail = detailId ? groups.find((g) => g.id === detailId) ?? null : null;

  return (
    <View style={styles.container}>
      {error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.filterBar}>
        <View style={styles.sortRow}>
          {(["recent", "trending"] as const).map((s) => {
            const active = sort === s;
            return (
              <TouchableOpacity
                key={s}
                style={[styles.sortBtn, active && styles.sortBtnActive]}
                onPress={() => setSort(s)}
              >
                <Text style={[styles.sortText, active && styles.sortTextActive]}>
                  {s === "recent" ? "Mới nhất" : "Nổi bật"}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {presentCategories.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipsRow}
          >
            {[null, ...presentCategories].map((c) => {
              const active = category === c;
              return (
                <TouchableOpacity
                  key={c ?? "all"}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => setCategory(c)}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {c ?? "Tất cả"}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}
      </View>
      <FlatList
        data={visible}
        keyExtractor={(g) => g.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          <Text style={styles.empty}>Chưa có tin nào. Kéo xuống để tải lại.</Text>
        }
        renderItem={({ item }) => {
          const summary = groupSummary(item);
          const note = pins.get(item.id);
          const cat = groupCategory(item);
          const read = reads.has(item.id);
          return (
            <View style={styles.card}>
              {cat ? <Text style={styles.badge}>{cat}</Text> : null}
              <View style={styles.cardHeader}>
                <TouchableOpacity style={styles.headerText} onPress={() => openDetail(item.id)}>
                  <Text style={[styles.title, read && styles.titleRead]}>{item.title}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => openEditor(item)} hitSlop={10}>
                  <Text style={styles.pin}>{pins.has(item.id) ? "★" : "☆"}</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity activeOpacity={0.6} onPress={() => openDetail(item.id)}>
                {summary?.summary_vi ? (
                  <Text style={styles.summary} numberOfLines={PREVIEW_LINES}>
                    {summary.summary_vi}
                  </Text>
                ) : (
                  <Text style={styles.pendingSummary}>Đang tóm tắt…</Text>
                )}
              </TouchableOpacity>
              {note ? <Text style={styles.note}>📝 {note}</Text> : null}
              <View style={styles.sourcesRow}>
                {item.articles.map((a) => (
                  <TouchableOpacity key={a.id} onPress={() => Linking.openURL(a.url)}>
                    <Text style={styles.sourceLink}>{a.sources?.name ?? "nguồn"}</Text>
                  </TouchableOpacity>
                ))}
                <Text style={styles.time}>{timeAgo(item.first_seen_at)}</Text>
              </View>
            </View>
          );
        }}
      />

      {detail && <DetailModal
        group={detail}
        pinned={pins.has(detail.id)}
        note={pins.get(detail.id) ?? ""}
        onClose={() => setDetailId(null)}
        onPin={() => openEditor(detail)}
      />}

      <Modal
        visible={editor !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setEditor(null)}
      >
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle} numberOfLines={2}>
              {editor?.existing ? "Ghi chú đã ghim" : "Ghim tin này"}
            </Text>
            <TextInput
              style={styles.noteInput}
              placeholder="Ghi chú (không bắt buộc)"
              value={editor?.note ?? ""}
              onChangeText={(t) => setEditor((e) => (e ? { ...e, note: t } : e))}
              multiline
              autoFocus
            />
            <View style={styles.modalActions}>
              {editor?.existing && (
                <TouchableOpacity onPress={removePin} disabled={saving} hitSlop={8}>
                  <Text style={styles.unpin}>Bỏ ghim</Text>
                </TouchableOpacity>
              )}
              <View style={styles.modalActionsRight}>
                <TouchableOpacity onPress={() => setEditor(null)} disabled={saving} hitSlop={8}>
                  <Text style={styles.cancel}>Hủy</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.saveButton} onPress={savePin} disabled={saving}>
                  <Text style={styles.saveButtonText}>
                    {editor?.existing ? "Lưu" : "Ghim"}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

// Full-detail screen for one story group: whole summary, note, every source
// link ("Đọc bài gốc"), and a pin toggle. Opened by tapping a feed card.
function DetailModal({
  group,
  pinned,
  note,
  onClose,
  onPin,
}: {
  group: FeedGroup;
  pinned: boolean;
  note: string;
  onClose: () => void;
  onPin: () => void;
}) {
  const summary = groupSummary(group);
  const cat = groupCategory(group);

  async function onShare() {
    const body = summary?.summary_vi ?? "";
    const links = group.articles
      .map((a) => `• ${a.sources?.name ?? "nguồn"}: ${a.url}`)
      .join("\n");
    try {
      await Share.share({ message: `${group.title}\n\n${body}\n\n${links}`.trim() });
    } catch {
      // user dismissed the share sheet — nothing to do
    }
  }

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.detailSafe} edges={["top", "bottom"]}>
        <View style={styles.detailBar}>
          <TouchableOpacity onPress={onClose} hitSlop={10}>
            <Text style={styles.detailClose}>‹ Quay lại</Text>
          </TouchableOpacity>
          <View style={styles.detailBarRight}>
            <TouchableOpacity onPress={onShare} hitSlop={10}>
              <Text style={styles.detailShare}>Chia sẻ</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onPin} hitSlop={10}>
              <Text style={styles.pin}>{pinned ? "★" : "☆"}</Text>
            </TouchableOpacity>
          </View>
        </View>
        <ScrollView contentContainerStyle={styles.detailBody}>
          {cat ? <Text style={styles.badge}>{cat}</Text> : null}
          <Text style={styles.detailTitle}>{group.title}</Text>
          <Text style={styles.detailTime}>{timeAgo(group.first_seen_at)}</Text>
          {note ? <Text style={styles.note}>📝 {note}</Text> : null}
          {summary?.summary_vi ? (
            <Text style={styles.detailSummary}>{summary.summary_vi}</Text>
          ) : (
            <Text style={styles.pendingSummary}>Đang tóm tắt…</Text>
          )}
          <Text style={styles.detailSourcesLabel}>Nguồn ({group.articles.length})</Text>
          {group.articles.map((a) => (
            <TouchableOpacity
              key={a.id}
              style={styles.detailSourceRow}
              onPress={() => Linking.openURL(a.url)}
            >
              <Text style={styles.detailSourceName}>{a.sources?.name ?? "nguồn"}</Text>
              <Text style={styles.detailSourceTitle} numberOfLines={2}>{a.title}</Text>
              <Text style={styles.detailReadOriginal}>Đọc bài gốc ›</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f4f4f5" },
  filterBar: {
    backgroundColor: "#fff",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e5e5e5",
  },
  sortRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 6,
    paddingHorizontal: 12,
    paddingTop: 10,
  },
  sortBtn: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 8 },
  sortBtnActive: { backgroundColor: "#fee2e2" },
  sortText: { fontSize: 13, fontWeight: "600", color: "#888" },
  sortTextActive: { color: "#b91c1c" },
  chipsRow: { paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "#f4f4f5",
    borderWidth: 1,
    borderColor: "#e5e5e5",
  },
  chipActive: { backgroundColor: "#b91c1c", borderColor: "#b91c1c" },
  chipText: { fontSize: 13.5, fontWeight: "600", color: "#444" },
  chipTextActive: { color: "#fff" },
  badge: {
    alignSelf: "flex-start",
    fontSize: 11.5,
    fontWeight: "700",
    color: "#b91c1c",
    backgroundColor: "#fee2e2",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginBottom: 8,
    overflow: "hidden",
  },
  card: {
    backgroundColor: "#fff",
    marginHorizontal: 12,
    marginTop: 12,
    borderRadius: 12,
    padding: 14,
  },
  cardHeader: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  headerText: { flex: 1 },
  title: { fontSize: 16, fontWeight: "700", lineHeight: 22 },
  titleRead: { color: "#9ca3af" },
  pin: { fontSize: 22, color: "#b91c1c" },
  summary: { marginTop: 8, fontSize: 14.5, lineHeight: 21, color: "#333" },
  pendingSummary: { marginTop: 8, fontStyle: "italic", color: "#999" },
  note: {
    marginTop: 10,
    fontSize: 13.5,
    lineHeight: 19,
    color: "#92400e",
    backgroundColor: "#fef3c7",
    borderRadius: 8,
    padding: 8,
  },
  sourcesRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 10,
    marginTop: 10,
  },
  sourceLink: { color: "#b91c1c", fontSize: 13, fontWeight: "600" },
  time: { color: "#999", fontSize: 12, marginLeft: "auto" },
  empty: { textAlign: "center", color: "#888", marginTop: 48 },
  error: { color: "#b91c1c", textAlign: "center", marginTop: 8 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: { backgroundColor: "#fff", borderRadius: 14, padding: 18 },
  modalTitle: { fontSize: 17, fontWeight: "700", marginBottom: 12 },
  noteInput: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    minHeight: 80,
    textAlignVertical: "top",
  },
  modalActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 16,
  },
  modalActionsRight: { flexDirection: "row", alignItems: "center", gap: 18, marginLeft: "auto" },
  unpin: { color: "#b91c1c", fontSize: 15 },
  cancel: { color: "#666", fontSize: 15 },
  saveButton: { backgroundColor: "#b91c1c", borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20 },
  saveButtonText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  detailSafe: { flex: 1, backgroundColor: "#fff" },
  detailBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ddd",
  },
  detailClose: { color: "#b91c1c", fontSize: 16, fontWeight: "600" },
  detailBarRight: { flexDirection: "row", alignItems: "center", gap: 18 },
  detailShare: { color: "#b91c1c", fontSize: 15, fontWeight: "600" },
  detailBody: { padding: 16, paddingBottom: 40 },
  detailTitle: { fontSize: 21, fontWeight: "800", lineHeight: 28 },
  detailTime: { color: "#999", fontSize: 13, marginTop: 6 },
  detailSummary: { marginTop: 14, fontSize: 16, lineHeight: 25, color: "#222" },
  detailSourcesLabel: {
    marginTop: 24,
    marginBottom: 4,
    fontSize: 13,
    fontWeight: "700",
    color: "#666",
    textTransform: "uppercase",
  },
  detailSourceRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#eee",
    paddingVertical: 12,
  },
  detailSourceName: { fontSize: 13, fontWeight: "700", color: "#b91c1c" },
  detailSourceTitle: { fontSize: 14.5, color: "#333", marginTop: 2, lineHeight: 20 },
  detailReadOriginal: { fontSize: 13, color: "#b91c1c", marginTop: 4 },
});
