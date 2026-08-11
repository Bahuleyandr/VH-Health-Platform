import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("notification outbox operator console contract", () => {
  it("exposes dead letters, cursor state, and reasoned recovery actions", () => {
    const component = readFileSync(
      resolve(
        process.cwd(),
        "src/app/(with-auth)/dashboard/notifications/components/NotificationOutboxConsole.tsx",
      ),
      "utf8",
    );
    const page = readFileSync(
      resolve(process.cwd(), "src/app/(with-auth)/dashboard/notifications/page.tsx"),
      "utf8",
    );

    expect(page).toContain('key: "delivery"');
    expect(page).toContain("<NotificationOutboxConsole />");
    expect(component).toContain("/admin/notification-outbox?status=");
    expect(component).toContain("/admin/notification-outbox/cursors");
    expect(component).toContain("/replay");
    expect(component).toContain("/reconcile");
    expect(component).toContain("/reset");
    expect(component).toContain("Operator reason");
    expect(component).toContain("Provider reference");
    expect(component).toContain("Provider evidence");
    expect(component).toContain("Receipt evidence");
    expect(component).toContain("Record acceptance");
  });
});
