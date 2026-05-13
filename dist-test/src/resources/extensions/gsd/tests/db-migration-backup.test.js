import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { backupDatabaseBeforeMigration } from "../db-migration-backup.js";
class FakeStatement {
  run() {
    return void 0;
  }
  get() {
    return void 0;
  }
  all() {
    return [];
  }
}
class FakeAdapter {
  execCalls = [];
  failCheckpoint = false;
  exec(sql) {
    this.execCalls.push(sql);
    if (this.failCheckpoint) throw new Error("checkpoint failed");
  }
  prepare() {
    return new FakeStatement();
  }
  close() {
  }
}
describe("db-migration-backup", () => {
  test("skips missing, memory, and already-backed-up databases", () => {
    const db = new FakeAdapter();
    const copies = [];
    const warnings = [];
    backupDatabaseBeforeMigration(db, null, 7, {
      existsSync: () => true,
      copyFileSync: (src, dest) => copies.push([src, dest]),
      logWarning: (_scope, message) => warnings.push(message)
    });
    backupDatabaseBeforeMigration(db, ":memory:", 7, {
      existsSync: () => true,
      copyFileSync: (src, dest) => copies.push([src, dest]),
      logWarning: (_scope, message) => warnings.push(message)
    });
    backupDatabaseBeforeMigration(db, "/tmp/gsd.db", 7, {
      existsSync: (path) => path.endsWith(".backup-v7"),
      copyFileSync: (src, dest) => copies.push([src, dest]),
      logWarning: (_scope, message) => warnings.push(message)
    });
    assert.deepEqual(copies, []);
    assert.deepEqual(warnings, []);
    assert.deepEqual(db.execCalls, []);
  });
  test("checkpoints before copying a file-backed database", () => {
    const db = new FakeAdapter();
    const copies = [];
    backupDatabaseBeforeMigration(db, "/tmp/gsd.db", 12, {
      existsSync: (path) => path === "/tmp/gsd.db",
      copyFileSync: (src, dest) => copies.push([src, dest]),
      logWarning: () => assert.fail("should not warn")
    });
    assert.deepEqual(db.execCalls, ["PRAGMA wal_checkpoint(TRUNCATE)"]);
    assert.deepEqual(copies, [["/tmp/gsd.db", "/tmp/gsd.db.backup-v12"]]);
  });
  test("continues copying when checkpoint fails and warns when copy fails", () => {
    const db = new FakeAdapter();
    db.failCheckpoint = true;
    const copies = [];
    const warnings = [];
    backupDatabaseBeforeMigration(db, "/tmp/gsd.db", 12, {
      existsSync: (path) => path === "/tmp/gsd.db",
      copyFileSync: (src, dest) => copies.push([src, dest]),
      logWarning: (_scope, message) => warnings.push(message)
    });
    assert.deepEqual(copies, [["/tmp/gsd.db", "/tmp/gsd.db.backup-v12"]]);
    backupDatabaseBeforeMigration(db, "/tmp/fail.db", 13, {
      existsSync: (path) => path === "/tmp/fail.db",
      copyFileSync: () => {
        throw new Error("read only");
      },
      logWarning: (_scope, message) => warnings.push(message)
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Pre-migration backup failed: read only/);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kYi1taWdyYXRpb24tYmFja3VwLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBUZXN0cyBmb3IgcHJlLW1pZ3JhdGlvbiBkYXRhYmFzZSBiYWNrdXAgaGVscGVyLlxuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgYmFja3VwRGF0YWJhc2VCZWZvcmVNaWdyYXRpb24gfSBmcm9tIFwiLi4vZGItbWlncmF0aW9uLWJhY2t1cC50c1wiO1xuaW1wb3J0IHR5cGUgeyBEYkFkYXB0ZXIsIERiU3RhdGVtZW50IH0gZnJvbSBcIi4uL2RiLWFkYXB0ZXIudHNcIjtcblxuY2xhc3MgRmFrZVN0YXRlbWVudCBpbXBsZW1lbnRzIERiU3RhdGVtZW50IHtcbiAgcnVuKCk6IHVua25vd24ge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cblxuICBnZXQoKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cblxuICBhbGwoKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj5bXSB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG59XG5cbmNsYXNzIEZha2VBZGFwdGVyIGltcGxlbWVudHMgRGJBZGFwdGVyIHtcbiAgcmVhZG9ubHkgZXhlY0NhbGxzOiBzdHJpbmdbXSA9IFtdO1xuICBmYWlsQ2hlY2twb2ludCA9IGZhbHNlO1xuXG4gIGV4ZWMoc3FsOiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLmV4ZWNDYWxscy5wdXNoKHNxbCk7XG4gICAgaWYgKHRoaXMuZmFpbENoZWNrcG9pbnQpIHRocm93IG5ldyBFcnJvcihcImNoZWNrcG9pbnQgZmFpbGVkXCIpO1xuICB9XG5cbiAgcHJlcGFyZSgpOiBEYlN0YXRlbWVudCB7XG4gICAgcmV0dXJuIG5ldyBGYWtlU3RhdGVtZW50KCk7XG4gIH1cblxuICBjbG9zZSgpOiB2b2lkIHt9XG59XG5cbmRlc2NyaWJlKFwiZGItbWlncmF0aW9uLWJhY2t1cFwiLCAoKSA9PiB7XG4gIHRlc3QoXCJza2lwcyBtaXNzaW5nLCBtZW1vcnksIGFuZCBhbHJlYWR5LWJhY2tlZC11cCBkYXRhYmFzZXNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGRiID0gbmV3IEZha2VBZGFwdGVyKCk7XG4gICAgY29uc3QgY29waWVzOiBBcnJheTxbc3RyaW5nLCBzdHJpbmddPiA9IFtdO1xuICAgIGNvbnN0IHdhcm5pbmdzOiBzdHJpbmdbXSA9IFtdO1xuXG4gICAgYmFja3VwRGF0YWJhc2VCZWZvcmVNaWdyYXRpb24oZGIsIG51bGwsIDcsIHtcbiAgICAgIGV4aXN0c1N5bmM6ICgpID0+IHRydWUsXG4gICAgICBjb3B5RmlsZVN5bmM6IChzcmMsIGRlc3QpID0+IGNvcGllcy5wdXNoKFtzcmMsIGRlc3RdKSxcbiAgICAgIGxvZ1dhcm5pbmc6IChfc2NvcGUsIG1lc3NhZ2UpID0+IHdhcm5pbmdzLnB1c2gobWVzc2FnZSksXG4gICAgfSk7XG4gICAgYmFja3VwRGF0YWJhc2VCZWZvcmVNaWdyYXRpb24oZGIsIFwiOm1lbW9yeTpcIiwgNywge1xuICAgICAgZXhpc3RzU3luYzogKCkgPT4gdHJ1ZSxcbiAgICAgIGNvcHlGaWxlU3luYzogKHNyYywgZGVzdCkgPT4gY29waWVzLnB1c2goW3NyYywgZGVzdF0pLFxuICAgICAgbG9nV2FybmluZzogKF9zY29wZSwgbWVzc2FnZSkgPT4gd2FybmluZ3MucHVzaChtZXNzYWdlKSxcbiAgICB9KTtcbiAgICBiYWNrdXBEYXRhYmFzZUJlZm9yZU1pZ3JhdGlvbihkYiwgXCIvdG1wL2dzZC5kYlwiLCA3LCB7XG4gICAgICBleGlzdHNTeW5jOiAocGF0aCkgPT4gcGF0aC5lbmRzV2l0aChcIi5iYWNrdXAtdjdcIiksXG4gICAgICBjb3B5RmlsZVN5bmM6IChzcmMsIGRlc3QpID0+IGNvcGllcy5wdXNoKFtzcmMsIGRlc3RdKSxcbiAgICAgIGxvZ1dhcm5pbmc6IChfc2NvcGUsIG1lc3NhZ2UpID0+IHdhcm5pbmdzLnB1c2gobWVzc2FnZSksXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZGVlcEVxdWFsKGNvcGllcywgW10pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwod2FybmluZ3MsIFtdKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGRiLmV4ZWNDYWxscywgW10pO1xuICB9KTtcblxuICB0ZXN0KFwiY2hlY2twb2ludHMgYmVmb3JlIGNvcHlpbmcgYSBmaWxlLWJhY2tlZCBkYXRhYmFzZVwiLCAoKSA9PiB7XG4gICAgY29uc3QgZGIgPSBuZXcgRmFrZUFkYXB0ZXIoKTtcbiAgICBjb25zdCBjb3BpZXM6IEFycmF5PFtzdHJpbmcsIHN0cmluZ10+ID0gW107XG5cbiAgICBiYWNrdXBEYXRhYmFzZUJlZm9yZU1pZ3JhdGlvbihkYiwgXCIvdG1wL2dzZC5kYlwiLCAxMiwge1xuICAgICAgZXhpc3RzU3luYzogKHBhdGgpID0+IHBhdGggPT09IFwiL3RtcC9nc2QuZGJcIixcbiAgICAgIGNvcHlGaWxlU3luYzogKHNyYywgZGVzdCkgPT4gY29waWVzLnB1c2goW3NyYywgZGVzdF0pLFxuICAgICAgbG9nV2FybmluZzogKCkgPT4gYXNzZXJ0LmZhaWwoXCJzaG91bGQgbm90IHdhcm5cIiksXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZGVlcEVxdWFsKGRiLmV4ZWNDYWxscywgW1wiUFJBR01BIHdhbF9jaGVja3BvaW50KFRSVU5DQVRFKVwiXSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChjb3BpZXMsIFtbXCIvdG1wL2dzZC5kYlwiLCBcIi90bXAvZ3NkLmRiLmJhY2t1cC12MTJcIl1dKTtcbiAgfSk7XG5cbiAgdGVzdChcImNvbnRpbnVlcyBjb3B5aW5nIHdoZW4gY2hlY2twb2ludCBmYWlscyBhbmQgd2FybnMgd2hlbiBjb3B5IGZhaWxzXCIsICgpID0+IHtcbiAgICBjb25zdCBkYiA9IG5ldyBGYWtlQWRhcHRlcigpO1xuICAgIGRiLmZhaWxDaGVja3BvaW50ID0gdHJ1ZTtcbiAgICBjb25zdCBjb3BpZXM6IEFycmF5PFtzdHJpbmcsIHN0cmluZ10+ID0gW107XG4gICAgY29uc3Qgd2FybmluZ3M6IHN0cmluZ1tdID0gW107XG5cbiAgICBiYWNrdXBEYXRhYmFzZUJlZm9yZU1pZ3JhdGlvbihkYiwgXCIvdG1wL2dzZC5kYlwiLCAxMiwge1xuICAgICAgZXhpc3RzU3luYzogKHBhdGgpID0+IHBhdGggPT09IFwiL3RtcC9nc2QuZGJcIixcbiAgICAgIGNvcHlGaWxlU3luYzogKHNyYywgZGVzdCkgPT4gY29waWVzLnB1c2goW3NyYywgZGVzdF0pLFxuICAgICAgbG9nV2FybmluZzogKF9zY29wZSwgbWVzc2FnZSkgPT4gd2FybmluZ3MucHVzaChtZXNzYWdlKSxcbiAgICB9KTtcblxuICAgIGFzc2VydC5kZWVwRXF1YWwoY29waWVzLCBbW1wiL3RtcC9nc2QuZGJcIiwgXCIvdG1wL2dzZC5kYi5iYWNrdXAtdjEyXCJdXSk7XG5cbiAgICBiYWNrdXBEYXRhYmFzZUJlZm9yZU1pZ3JhdGlvbihkYiwgXCIvdG1wL2ZhaWwuZGJcIiwgMTMsIHtcbiAgICAgIGV4aXN0c1N5bmM6IChwYXRoKSA9PiBwYXRoID09PSBcIi90bXAvZmFpbC5kYlwiLFxuICAgICAgY29weUZpbGVTeW5jOiAoKSA9PiB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcInJlYWQgb25seVwiKTtcbiAgICAgIH0sXG4gICAgICBsb2dXYXJuaW5nOiAoX3Njb3BlLCBtZXNzYWdlKSA9PiB3YXJuaW5ncy5wdXNoKG1lc3NhZ2UpLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHdhcm5pbmdzLmxlbmd0aCwgMSk7XG4gICAgYXNzZXJ0Lm1hdGNoKHdhcm5pbmdzWzBdLCAvUHJl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
