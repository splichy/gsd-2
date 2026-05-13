function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new Error("Aborted"));
    });
  });
}
export {
  sleep
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy91dGlscy9zbGVlcC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBTbGVlcCBoZWxwZXIgdGhhdCByZXNwZWN0cyBhYm9ydCBzaWduYWwuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzbGVlcChtczogbnVtYmVyLCBzaWduYWw/OiBBYm9ydFNpZ25hbCk6IFByb21pc2U8dm9pZD4ge1xuXHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdGlmIChzaWduYWw/LmFib3J0ZWQpIHtcblx0XHRcdHJlamVjdChuZXcgRXJyb3IoXCJBYm9ydGVkXCIpKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCB0aW1lb3V0ID0gc2V0VGltZW91dChyZXNvbHZlLCBtcyk7XG5cblx0XHRzaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCAoKSA9PiB7XG5cdFx0XHRjbGVhclRpbWVvdXQodGltZW91dCk7XG5cdFx0XHRyZWplY3QobmV3IEVycm9yKFwiQWJvcnRlZFwiKSk7XG5cdFx0fSk7XG5cdH0pO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBR08sU0FBUyxNQUFNLElBQVksUUFBcUM7QUFDdEUsU0FBTyxJQUFJLFFBQVEsQ0FBQyxTQUFTLFdBQVc7QUFDdkMsUUFBSSxRQUFRLFNBQVM7QUFDcEIsYUFBTyxJQUFJLE1BQU0sU0FBUyxDQUFDO0FBQzNCO0FBQUEsSUFDRDtBQUVBLFVBQU0sVUFBVSxXQUFXLFNBQVMsRUFBRTtBQUV0QyxZQUFRLGlCQUFpQixTQUFTLE1BQU07QUFDdkMsbUJBQWEsT0FBTztBQUNwQixhQUFPLElBQUksTUFBTSxTQUFTLENBQUM7QUFBQSxJQUM1QixDQUFDO0FBQUEsRUFDRixDQUFDO0FBQ0Y7IiwKICAibmFtZXMiOiBbXQp9Cg==
