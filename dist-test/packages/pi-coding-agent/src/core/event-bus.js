import { EventEmitter } from "node:events";
function createEventBus() {
  const emitter = new EventEmitter();
  return {
    emit: (channel, data) => {
      emitter.emit(channel, data);
    },
    on: (channel, handler) => {
      const safeHandler = async (data) => {
        try {
          await handler(data);
        } catch (err) {
          console.error(`Event handler error (${channel}):`, err);
        }
      };
      emitter.on(channel, safeHandler);
      return () => emitter.off(channel, safeHandler);
    },
    clear: () => {
      emitter.removeAllListeners();
    }
  };
}
export {
  createEventBus
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2V2ZW50LWJ1cy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgRXZlbnRFbWl0dGVyIH0gZnJvbSBcIm5vZGU6ZXZlbnRzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRXZlbnRCdXMge1xuXHRlbWl0KGNoYW5uZWw6IHN0cmluZywgZGF0YTogdW5rbm93bik6IHZvaWQ7XG5cdG9uKGNoYW5uZWw6IHN0cmluZywgaGFuZGxlcjogKGRhdGE6IHVua25vd24pID0+IHZvaWQpOiAoKSA9PiB2b2lkO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEV2ZW50QnVzQ29udHJvbGxlciBleHRlbmRzIEV2ZW50QnVzIHtcblx0Y2xlYXIoKTogdm9pZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUV2ZW50QnVzKCk6IEV2ZW50QnVzQ29udHJvbGxlciB7XG5cdGNvbnN0IGVtaXR0ZXIgPSBuZXcgRXZlbnRFbWl0dGVyKCk7XG5cdHJldHVybiB7XG5cdFx0ZW1pdDogKGNoYW5uZWwsIGRhdGEpID0+IHtcblx0XHRcdGVtaXR0ZXIuZW1pdChjaGFubmVsLCBkYXRhKTtcblx0XHR9LFxuXHRcdG9uOiAoY2hhbm5lbCwgaGFuZGxlcikgPT4ge1xuXHRcdFx0Y29uc3Qgc2FmZUhhbmRsZXIgPSBhc3luYyAoZGF0YTogdW5rbm93bikgPT4ge1xuXHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdGF3YWl0IGhhbmRsZXIoZGF0YSk7XG5cdFx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYEV2ZW50IGhhbmRsZXIgZXJyb3IgKCR7Y2hhbm5lbH0pOmAsIGVycik7XG5cdFx0XHRcdH1cblx0XHRcdH07XG5cdFx0XHRlbWl0dGVyLm9uKGNoYW5uZWwsIHNhZmVIYW5kbGVyKTtcblx0XHRcdHJldHVybiAoKSA9PiBlbWl0dGVyLm9mZihjaGFubmVsLCBzYWZlSGFuZGxlcik7XG5cdFx0fSxcblx0XHRjbGVhcjogKCkgPT4ge1xuXHRcdFx0ZW1pdHRlci5yZW1vdmVBbGxMaXN0ZW5lcnMoKTtcblx0XHR9LFxuXHR9O1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxvQkFBb0I7QUFXdEIsU0FBUyxpQkFBcUM7QUFDcEQsUUFBTSxVQUFVLElBQUksYUFBYTtBQUNqQyxTQUFPO0FBQUEsSUFDTixNQUFNLENBQUMsU0FBUyxTQUFTO0FBQ3hCLGNBQVEsS0FBSyxTQUFTLElBQUk7QUFBQSxJQUMzQjtBQUFBLElBQ0EsSUFBSSxDQUFDLFNBQVMsWUFBWTtBQUN6QixZQUFNLGNBQWMsT0FBTyxTQUFrQjtBQUM1QyxZQUFJO0FBQ0gsZ0JBQU0sUUFBUSxJQUFJO0FBQUEsUUFDbkIsU0FBUyxLQUFLO0FBQ2Isa0JBQVEsTUFBTSx3QkFBd0IsT0FBTyxNQUFNLEdBQUc7QUFBQSxRQUN2RDtBQUFBLE1BQ0Q7QUFDQSxjQUFRLEdBQUcsU0FBUyxXQUFXO0FBQy9CLGFBQU8sTUFBTSxRQUFRLElBQUksU0FBUyxXQUFXO0FBQUEsSUFDOUM7QUFBQSxJQUNBLE9BQU8sTUFBTTtBQUNaLGNBQVEsbUJBQW1CO0FBQUEsSUFDNUI7QUFBQSxFQUNEO0FBQ0Q7IiwKICAibmFtZXMiOiBbXQp9Cg==
