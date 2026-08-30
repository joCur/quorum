import { ConsentNotice } from "@quorum/client";

const noop = () => undefined;

export function BeforeRecording() {
  return <ConsentNotice open onConfirm={noop} onCancel={noop} />;
}
