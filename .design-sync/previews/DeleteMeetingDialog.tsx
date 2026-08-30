import { DeleteMeetingDialog } from "@quorum/client";

const noop = () => {};

export function ConfirmCascade() {
  return (
    <DeleteMeetingDialog
      meetingLabel="Weekly product sync — Aug 28, 2026"
      open
      onOpenChange={noop}
      onConfirm={noop}
    />
  );
}
