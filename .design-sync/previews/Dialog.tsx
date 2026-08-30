import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Label,
} from "@quorum/client";

const header: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };
const footer: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 4,
};

export function RenameMeeting() {
  return (
    <Dialog open modal={false}>
      <DialogContent closeLabel="Close">
        <div style={header}>
          <DialogTitle>Rename meeting</DialogTitle>
          <DialogDescription>
            The new title appears in the meeting list and on the shared summary.
          </DialogDescription>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Label htmlFor="dialog-title">Meeting title</Label>
          <Input id="dialog-title" defaultValue="Quarterly roadmap review" />
        </div>
        <div style={footer}>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button>Save title</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ShareSummary() {
  return (
    <Dialog open modal={false}>
      <DialogContent closeLabel="Close">
        <div style={header}>
          <DialogTitle>Share summary</DialogTitle>
          <DialogDescription>
            Anyone with the link can read the summary and the transcript of “Customer interview:
            Acme”. The audio stays private to your workspace.
          </DialogDescription>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Label htmlFor="dialog-link">Share link</Label>
          <Input id="dialog-link" readOnly defaultValue="https://quorum.app/s/9f3ka2-summary" />
        </div>
        <div style={footer}>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button>Copy link</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
