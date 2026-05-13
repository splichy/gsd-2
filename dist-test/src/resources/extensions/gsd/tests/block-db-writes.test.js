import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isBlockedStateFile, isBashWriteToStateFile } from "../write-intercept.js";
describe("isBlockedStateFile blocks gsd.db paths (#3674)", () => {
  test("blocks .gsd/gsd.db", () => {
    assert.ok(isBlockedStateFile("/project/.gsd/gsd.db"));
  });
  test("blocks .gsd/gsd.db-wal", () => {
    assert.ok(isBlockedStateFile("/project/.gsd/gsd.db-wal"));
  });
  test("blocks .gsd/gsd.db-shm", () => {
    assert.ok(isBlockedStateFile("/project/.gsd/gsd.db-shm"));
  });
  test("blocks resolved symlink path under .gsd/projects/", () => {
    assert.ok(isBlockedStateFile("/home/user/.gsd/projects/myproj/gsd.db"));
  });
  test("still blocks STATE.md", () => {
    assert.ok(isBlockedStateFile("/project/.gsd/STATE.md"));
  });
  test("does not block other .gsd files", () => {
    assert.ok(!isBlockedStateFile("/project/.gsd/DECISIONS.md"));
  });
});
describe("isBashWriteToStateFile blocks DB shell commands (#3674)", () => {
  test("blocks sqlite3 targeting gsd.db", () => {
    assert.ok(isBashWriteToStateFile('sqlite3 .gsd/gsd.db "INSERT INTO ..."'));
  });
  test("blocks better-sqlite3 targeting gsd.db", () => {
    assert.ok(isBashWriteToStateFile(`node -e "require('better-sqlite3')('.gsd/gsd.db')"`));
  });
  test("blocks shell redirect to gsd.db", () => {
    assert.ok(isBashWriteToStateFile("echo data > .gsd/gsd.db"));
  });
  test("blocks cp to gsd.db", () => {
    assert.ok(isBashWriteToStateFile("cp backup.db .gsd/gsd.db"));
  });
  test("blocks mv to gsd.db", () => {
    assert.ok(isBashWriteToStateFile("mv temp.db .gsd/gsd.db"));
  });
  test("does not block reading gsd.db with cat", () => {
    assert.ok(!isBashWriteToStateFile("cat .gsd/gsd.db"));
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9ibG9jay1kYi13cml0ZXMudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBSZWdyZXNzaW9uIHRlc3QgZm9yICMzNjc0IFx1MjAxNCBibG9jayBkaXJlY3Qgd3JpdGVzIHRvIGdzZC5kYlxuICpcbiAqIFdoZW4gZ3NkX2NvbXBsZXRlX3Rhc2sgd2FzIHVuYXZhaWxhYmxlLCBhZ2VudHMgZmVsbCBiYWNrIHRvIHNoZWxsLWJhc2VkXG4gKiBzcWxpdGUzIHdyaXRlcywgY29ycnVwdGluZyB0aGUgV0FMLWJhY2tlZCBkYXRhYmFzZS4gVGhlIGZpeCBleHRlbmRzXG4gKiB3cml0ZS1pbnRlcmNlcHQgdG8gYmxvY2sgZmlsZSB3cml0ZXMgYW5kIGJhc2ggY29tbWFuZHMgdGFyZ2V0aW5nIGdzZC5kYi5cbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgeyBpc0Jsb2NrZWRTdGF0ZUZpbGUsIGlzQmFzaFdyaXRlVG9TdGF0ZUZpbGUgfSBmcm9tICcuLi93cml0ZS1pbnRlcmNlcHQudHMnO1xuXG5kZXNjcmliZSgnaXNCbG9ja2VkU3RhdGVGaWxlIGJsb2NrcyBnc2QuZGIgcGF0aHMgKCMzNjc0KScsICgpID0+IHtcbiAgdGVzdCgnYmxvY2tzIC5nc2QvZ3NkLmRiJywgKCkgPT4ge1xuICAgIGFzc2VydC5vayhpc0Jsb2NrZWRTdGF0ZUZpbGUoJy9wcm9qZWN0Ly5nc2QvZ3NkLmRiJykpO1xuICB9KTtcblxuICB0ZXN0KCdibG9ja3MgLmdzZC9nc2QuZGItd2FsJywgKCkgPT4ge1xuICAgIGFzc2VydC5vayhpc0Jsb2NrZWRTdGF0ZUZpbGUoJy9wcm9qZWN0Ly5nc2QvZ3NkLmRiLXdhbCcpKTtcbiAgfSk7XG5cbiAgdGVzdCgnYmxvY2tzIC5nc2QvZ3NkLmRiLXNobScsICgpID0+IHtcbiAgICBhc3NlcnQub2soaXNCbG9ja2VkU3RhdGVGaWxlKCcvcHJvamVjdC8uZ3NkL2dzZC5kYi1zaG0nKSk7XG4gIH0pO1xuXG4gIHRlc3QoJ2Jsb2NrcyByZXNvbHZlZCBzeW1saW5rIHBhdGggdW5kZXIgLmdzZC9wcm9qZWN0cy8nLCAoKSA9PiB7XG4gICAgYXNzZXJ0Lm9rKGlzQmxvY2tlZFN0YXRlRmlsZSgnL2hvbWUvdXNlci8uZ3NkL3Byb2plY3RzL215cHJvai9nc2QuZGInKSk7XG4gIH0pO1xuXG4gIHRlc3QoJ3N0aWxsIGJsb2NrcyBTVEFURS5tZCcsICgpID0+IHtcbiAgICBhc3NlcnQub2soaXNCbG9ja2VkU3RhdGVGaWxlKCcvcHJvamVjdC8uZ3NkL1NUQVRFLm1kJykpO1xuICB9KTtcblxuICB0ZXN0KCdkb2VzIG5vdCBibG9jayBvdGhlciAuZ3NkIGZpbGVzJywgKCkgPT4ge1xuICAgIGFzc2VydC5vayghaXNCbG9ja2VkU3RhdGVGaWxlKCcvcHJvamVjdC8uZ3NkL0RFQ0lTSU9OUy5tZCcpKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoJ2lzQmFzaFdyaXRlVG9TdGF0ZUZpbGUgYmxvY2tzIERCIHNoZWxsIGNvbW1hbmRzICgjMzY3NCknLCAoKSA9PiB7XG4gIHRlc3QoJ2Jsb2NrcyBzcWxpdGUzIHRhcmdldGluZyBnc2QuZGInLCAoKSA9PiB7XG4gICAgYXNzZXJ0Lm9rKGlzQmFzaFdyaXRlVG9TdGF0ZUZpbGUoJ3NxbGl0ZTMgLmdzZC9nc2QuZGIgXCJJTlNFUlQgSU5UTyAuLi5cIicpKTtcbiAgfSk7XG5cbiAgdGVzdCgnYmxvY2tzIGJldHRlci1zcWxpdGUzIHRhcmdldGluZyBnc2QuZGInLCAoKSA9PiB7XG4gICAgYXNzZXJ0Lm9rKGlzQmFzaFdyaXRlVG9TdGF0ZUZpbGUoJ25vZGUgLWUgXCJyZXF1aXJlKFxcJ2JldHRlci1zcWxpdGUzXFwnKShcXCcuZ3NkL2dzZC5kYlxcJylcIicpKTtcbiAgfSk7XG5cbiAgdGVzdCgnYmxvY2tzIHNoZWxsIHJlZGlyZWN0IHRvIGdzZC5kYicsICgpID0+IHtcbiAgICBhc3NlcnQub2soaXNCYXNoV3JpdGVUb1N0YXRlRmlsZSgnZWNobyBkYXRhID4gLmdzZC9nc2QuZGInKSk7XG4gIH0pO1xuXG4gIHRlc3QoJ2Jsb2NrcyBjcCB0byBnc2QuZGInLCAoKSA9PiB7XG4gICAgYXNzZXJ0Lm9rKGlzQmFzaFdyaXRlVG9TdGF0ZUZpbGUoJ2NwIGJhY2t1cC5kYiAuZ3NkL2dzZC5kYicpKTtcbiAgfSk7XG5cbiAgdGVzdCgnYmxvY2tzIG12IHRvIGdzZC5kYicsICgpID0+IHtcbiAgICBhc3NlcnQub2soaXNCYXNoV3JpdGVUb1N0YXRlRmlsZSgnbXYgdGVtcC5kYiAuZ3NkL2dzZC5kYicpKTtcbiAgfSk7XG5cbiAgdGVzdCgnZG9lcyBub3QgYmxvY2sgcmVhZGluZyBnc2QuZGIgd2l0aCBjYXQnLCAoKSA9PiB7XG4gICAgYXNzZXJ0Lm9rKCFpc0Jhc2hXcml0ZVRvU3RhdGVGaWxlKCdjYXQgLmdzZC9nc2QuZGInKSk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFRQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxvQkFBb0IsOEJBQThCO0FBRTNELFNBQVMsa0RBQWtELE1BQU07QUFDL0QsT0FBSyxzQkFBc0IsTUFBTTtBQUMvQixXQUFPLEdBQUcsbUJBQW1CLHNCQUFzQixDQUFDO0FBQUEsRUFDdEQsQ0FBQztBQUVELE9BQUssMEJBQTBCLE1BQU07QUFDbkMsV0FBTyxHQUFHLG1CQUFtQiwwQkFBMEIsQ0FBQztBQUFBLEVBQzFELENBQUM7QUFFRCxPQUFLLDBCQUEwQixNQUFNO0FBQ25DLFdBQU8sR0FBRyxtQkFBbUIsMEJBQTBCLENBQUM7QUFBQSxFQUMxRCxDQUFDO0FBRUQsT0FBSyxxREFBcUQsTUFBTTtBQUM5RCxXQUFPLEdBQUcsbUJBQW1CLHdDQUF3QyxDQUFDO0FBQUEsRUFDeEUsQ0FBQztBQUVELE9BQUsseUJBQXlCLE1BQU07QUFDbEMsV0FBTyxHQUFHLG1CQUFtQix3QkFBd0IsQ0FBQztBQUFBLEVBQ3hELENBQUM7QUFFRCxPQUFLLG1DQUFtQyxNQUFNO0FBQzVDLFdBQU8sR0FBRyxDQUFDLG1CQUFtQiw0QkFBNEIsQ0FBQztBQUFBLEVBQzdELENBQUM7QUFDSCxDQUFDO0FBRUQsU0FBUywyREFBMkQsTUFBTTtBQUN4RSxPQUFLLG1DQUFtQyxNQUFNO0FBQzVDLFdBQU8sR0FBRyx1QkFBdUIsdUNBQXVDLENBQUM7QUFBQSxFQUMzRSxDQUFDO0FBRUQsT0FBSywwQ0FBMEMsTUFBTTtBQUNuRCxXQUFPLEdBQUcsdUJBQXVCLG9EQUF3RCxDQUFDO0FBQUEsRUFDNUYsQ0FBQztBQUVELE9BQUssbUNBQW1DLE1BQU07QUFDNUMsV0FBTyxHQUFHLHVCQUF1Qix5QkFBeUIsQ0FBQztBQUFBLEVBQzdELENBQUM7QUFFRCxPQUFLLHVCQUF1QixNQUFNO0FBQ2hDLFdBQU8sR0FBRyx1QkFBdUIsMEJBQTBCLENBQUM7QUFBQSxFQUM5RCxDQUFDO0FBRUQsT0FBSyx1QkFBdUIsTUFBTTtBQUNoQyxXQUFPLEdBQUcsdUJBQXVCLHdCQUF3QixDQUFDO0FBQUEsRUFDNUQsQ0FBQztBQUVELE9BQUssMENBQTBDLE1BQU07QUFDbkQsV0FBTyxHQUFHLENBQUMsdUJBQXVCLGlCQUFpQixDQUFDO0FBQUEsRUFDdEQsQ0FBQztBQUNILENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
