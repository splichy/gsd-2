class DbTransactionRunner {
  depth = 0;
  isInTransaction() {
    return this.depth > 0;
  }
  transaction(controls, fn) {
    if (this.depth > 0) {
      return this.runNested(fn);
    }
    controls.begin();
    this.depth++;
    try {
      const result = fn();
      controls.commit();
      return result;
    } catch (err) {
      controls.rollback();
      throw err;
    } finally {
      this.depth--;
    }
  }
  readTransaction(controls, fn, logRollbackError) {
    if (this.depth > 0) {
      return this.runNested(fn);
    }
    controls.beginRead();
    this.depth++;
    try {
      const result = fn();
      controls.commit();
      return result;
    } catch (err) {
      try {
        controls.rollback();
      } catch (rollbackErr) {
        logRollbackError(rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)));
      }
      throw err;
    } finally {
      this.depth--;
    }
  }
  runNested(fn) {
    this.depth++;
    try {
      return fn();
    } finally {
      this.depth--;
    }
  }
}
function createDbTransactionRunner() {
  return new DbTransactionRunner();
}
export {
  DbTransactionRunner,
  createDbTransactionRunner
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9kYi10cmFuc2FjdGlvbi50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFRyYW5zYWN0aW9uIGRlcHRoIGhlbHBlciBmb3IgdGhlIEdTRCBkYXRhYmFzZSBmYWNhZGUuXG5cbmV4cG9ydCBpbnRlcmZhY2UgRGJUcmFuc2FjdGlvbkNvbnRyb2xzIHtcbiAgYmVnaW4oKTogdm9pZDtcbiAgYmVnaW5SZWFkKCk6IHZvaWQ7XG4gIGNvbW1pdCgpOiB2b2lkO1xuICByb2xsYmFjaygpOiB2b2lkO1xufVxuXG5leHBvcnQgY2xhc3MgRGJUcmFuc2FjdGlvblJ1bm5lciB7XG4gIHByaXZhdGUgZGVwdGggPSAwO1xuXG4gIGlzSW5UcmFuc2FjdGlvbigpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5kZXB0aCA+IDA7XG4gIH1cblxuICB0cmFuc2FjdGlvbjxUPihjb250cm9sczogRGJUcmFuc2FjdGlvbkNvbnRyb2xzLCBmbjogKCkgPT4gVCk6IFQge1xuICAgIGlmICh0aGlzLmRlcHRoID4gMCkge1xuICAgICAgcmV0dXJuIHRoaXMucnVuTmVzdGVkKGZuKTtcbiAgICB9XG5cbiAgICBjb250cm9scy5iZWdpbigpO1xuICAgIHRoaXMuZGVwdGgrKztcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzdWx0ID0gZm4oKTtcbiAgICAgIGNvbnRyb2xzLmNvbW1pdCgpO1xuICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGNvbnRyb2xzLnJvbGxiYWNrKCk7XG4gICAgICB0aHJvdyBlcnI7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHRoaXMuZGVwdGgtLTtcbiAgICB9XG4gIH1cblxuICByZWFkVHJhbnNhY3Rpb248VD4oXG4gICAgY29udHJvbHM6IERiVHJhbnNhY3Rpb25Db250cm9scyxcbiAgICBmbjogKCkgPT4gVCxcbiAgICBsb2dSb2xsYmFja0Vycm9yOiAoZXJyb3I6IEVycm9yKSA9PiB2b2lkLFxuICApOiBUIHtcbiAgICBpZiAodGhpcy5kZXB0aCA+IDApIHtcbiAgICAgIHJldHVybiB0aGlzLnJ1bk5lc3RlZChmbik7XG4gICAgfVxuXG4gICAgY29udHJvbHMuYmVnaW5SZWFkKCk7XG4gICAgdGhpcy5kZXB0aCsrO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXN1bHQgPSBmbigpO1xuICAgICAgY29udHJvbHMuY29tbWl0KCk7XG4gICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29udHJvbHMucm9sbGJhY2soKTtcbiAgICAgIH0gY2F0Y2ggKHJvbGxiYWNrRXJyKSB7XG4gICAgICAgIGxvZ1JvbGxiYWNrRXJyb3Iocm9sbGJhY2tFcnIgaW5zdGFuY2VvZiBFcnJvciA/IHJvbGxiYWNrRXJyIDogbmV3IEVycm9yKFN0cmluZyhyb2xsYmFja0VycikpKTtcbiAgICAgIH1cbiAgICAgIHRocm93IGVycjtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgdGhpcy5kZXB0aC0tO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgcnVuTmVzdGVkPFQ+KGZuOiAoKSA9PiBUKTogVCB7XG4gICAgdGhpcy5kZXB0aCsrO1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gZm4oKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgdGhpcy5kZXB0aC0tO1xuICAgIH1cbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlRGJUcmFuc2FjdGlvblJ1bm5lcigpOiBEYlRyYW5zYWN0aW9uUnVubmVyIHtcbiAgcmV0dXJuIG5ldyBEYlRyYW5zYWN0aW9uUnVubmVyKCk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFVTyxNQUFNLG9CQUFvQjtBQUFBLEVBQ3ZCLFFBQVE7QUFBQSxFQUVoQixrQkFBMkI7QUFDekIsV0FBTyxLQUFLLFFBQVE7QUFBQSxFQUN0QjtBQUFBLEVBRUEsWUFBZSxVQUFpQyxJQUFnQjtBQUM5RCxRQUFJLEtBQUssUUFBUSxHQUFHO0FBQ2xCLGFBQU8sS0FBSyxVQUFVLEVBQUU7QUFBQSxJQUMxQjtBQUVBLGFBQVMsTUFBTTtBQUNmLFNBQUs7QUFDTCxRQUFJO0FBQ0YsWUFBTSxTQUFTLEdBQUc7QUFDbEIsZUFBUyxPQUFPO0FBQ2hCLGFBQU87QUFBQSxJQUNULFNBQVMsS0FBSztBQUNaLGVBQVMsU0FBUztBQUNsQixZQUFNO0FBQUEsSUFDUixVQUFFO0FBQ0EsV0FBSztBQUFBLElBQ1A7QUFBQSxFQUNGO0FBQUEsRUFFQSxnQkFDRSxVQUNBLElBQ0Esa0JBQ0c7QUFDSCxRQUFJLEtBQUssUUFBUSxHQUFHO0FBQ2xCLGFBQU8sS0FBSyxVQUFVLEVBQUU7QUFBQSxJQUMxQjtBQUVBLGFBQVMsVUFBVTtBQUNuQixTQUFLO0FBQ0wsUUFBSTtBQUNGLFlBQU0sU0FBUyxHQUFHO0FBQ2xCLGVBQVMsT0FBTztBQUNoQixhQUFPO0FBQUEsSUFDVCxTQUFTLEtBQUs7QUFDWixVQUFJO0FBQ0YsaUJBQVMsU0FBUztBQUFBLE1BQ3BCLFNBQVMsYUFBYTtBQUNwQix5QkFBaUIsdUJBQXVCLFFBQVEsY0FBYyxJQUFJLE1BQU0sT0FBTyxXQUFXLENBQUMsQ0FBQztBQUFBLE1BQzlGO0FBQ0EsWUFBTTtBQUFBLElBQ1IsVUFBRTtBQUNBLFdBQUs7QUFBQSxJQUNQO0FBQUEsRUFDRjtBQUFBLEVBRVEsVUFBYSxJQUFnQjtBQUNuQyxTQUFLO0FBQ0wsUUFBSTtBQUNGLGFBQU8sR0FBRztBQUFBLElBQ1osVUFBRTtBQUNBLFdBQUs7QUFBQSxJQUNQO0FBQUEsRUFDRjtBQUNGO0FBRU8sU0FBUyw0QkFBaUQ7QUFDL0QsU0FBTyxJQUFJLG9CQUFvQjtBQUNqQzsiLAogICJuYW1lcyI6IFtdCn0K
