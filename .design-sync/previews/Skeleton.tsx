import { Skeleton } from "@quorum/client";

export function MeetingListRow() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        maxWidth: 480,
        width: "100%",
      }}
    >
      <Skeleton style={{ height: 40, width: 40, borderRadius: 9999, flexShrink: 0 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
        <Skeleton style={{ height: 16, width: "60%" }} />
        <Skeleton style={{ height: 12, width: "38%" }} />
      </div>
      <Skeleton style={{ height: 24, width: 92, borderRadius: 9999, flexShrink: 0 }} />
    </div>
  );
}

export function MeetingListLoading() {
  const widths = ["64%", "48%", "72%"];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 480, width: "100%" }}>
      {widths.map((w) => (
        <div key={w} style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <Skeleton style={{ height: 40, width: 40, borderRadius: 9999, flexShrink: 0 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
            <Skeleton style={{ height: 16, width: w }} />
            <Skeleton style={{ height: 12, width: "34%" }} />
          </div>
          <Skeleton style={{ height: 24, width: 92, borderRadius: 9999, flexShrink: 0 }} />
        </div>
      ))}
    </div>
  );
}

export function TranscriptLoading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 480, width: "100%" }}>
      <Skeleton style={{ height: 24, width: 200 }} />
      <Skeleton style={{ height: 12, width: "100%" }} />
      <Skeleton style={{ height: 12, width: "94%" }} />
      <Skeleton style={{ height: 12, width: "82%" }} />
      <Skeleton style={{ height: 12, width: "88%" }} />
      <Skeleton style={{ height: 12, width: "46%" }} />
    </div>
  );
}
