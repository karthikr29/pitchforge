import { AudioQueue } from "../audioQueue";

describe("AudioQueue", () => {
  it("enqueues and shifts items", async () => {
    const q = new AudioQueue();
    q.enqueue({ id: "1", uri: "file://a" });
    expect(q.items()).toHaveLength(1);
    q.next();
    expect(q.items()).toHaveLength(0);
  });
});

