import { FieldValue, closeLocalDatabase, getLocalFirestore } from "@/lib/local-db"

const collection = `rawroute_local_smoke_${process.pid}`
const db = getLocalFirestore()
const documents = db.collection(collection)
const counter = documents.doc("counter")

async function main() {
  try {
    await counter.set({ count: 0, label: "initial" })
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(counter)
      if (!snapshot.exists) throw new Error("Smoke document was not created.")
      transaction.update(counter, { count: FieldValue.increment(1) })
    })
    const batch = db.batch()
    batch.set(documents.doc("z-last"), { count: 3, label: "last" })
    batch.set(documents.doc("a-first"), { count: 2, label: "first" })
    batch.set(documents.doc("m-ten"), { count: 10, label: "ten", tags: ["alpha", "beta"] })
    await batch.commit()

    const queried = await documents.where("count", ">=", 2).orderBy("label", "asc").get()
    const selected = await documents.where("count", "in", [3, 10]).get()
    const tagged = await documents.where("tags", "array-contains", "beta").get()
    const taggedAny = await documents.where("tags", "array-contains-any", ["missing", "alpha"]).get()
    await Promise.all(Array.from({ length: 8 }, () => db.runTransaction(async (transaction) => {
      transaction.update(counter, { count: FieldValue.increment(1) })
    })))
    const current = await counter.get()
    if (current.data()?.count !== 9) throw new Error("Concurrent transactional increments were not serialized correctly.")
    if (queried.docs.length !== 3 || queried.docs[0]?.id !== "a-first" || queried.docs[2]?.id !== "m-ten") throw new Error("Local numeric query/order behavior is incorrect.")
    if (selected.size !== 2 || tagged.size !== 1 || taggedAny.size !== 1) throw new Error("Local membership query behavior is incorrect.")
    const siblingPath = collection.replace("_", "X")
    const sibling = db.collection(siblingPath).doc("must-survive")
    await sibling.set({ keep: true })
    await db.recursiveDelete(documents)
    if (!(await sibling.get()).exists) throw new Error("Recursive delete matched a wildcard sibling path.")
    await sibling.delete()
    console.log(JSON.stringify({ ok: true, collection, queried: queried.docs.map((doc) => doc.id), selected: selected.docs.map((doc) => doc.id), tagged: tagged.docs.map((doc) => doc.id), count: current.data()?.count }, null, 2))
  } finally {
    await db.recursiveDelete(documents)
    await closeLocalDatabase()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
