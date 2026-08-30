import { MeetingSearch } from "@quorum/client";

const noop = () => {};

export function Empty() {
  return (
    <div style={{ width: 360 }}>
      <MeetingSearch value="" onChange={noop} />
    </div>
  );
}

export function WithQuery() {
  return (
    <div style={{ width: 360 }}>
      <MeetingSearch value="product sync" onChange={noop} />
    </div>
  );
}
