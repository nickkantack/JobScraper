from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi import Request
import uvicorn, json, os, hashlib


app = FastAPI()
FILE = "kv_store.json"

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def load_db():
    if not os.path.exists(FILE):
        return {}
    with open(FILE, "r") as f:
        return json.load(f)


def save_db(db):
    with open(FILE, "w") as f:
        json.dump(db, f)


@app.get("/kv/healthcheck")
def healtcheck():
    return {"ok": True}


@app.get("/kv/{key}")
def read(key: str):
    db = load_db()
    if key not in db:
        raise HTTPException(404)
    return db[key]


@app.put("/kv/{key}")
async def write(key: str, request: Request):
    db = load_db()
    db[key] = await request.json()
    print(db[key])
    save_db(db)
    return {"ok": True}


@app.put("/blob/{key}")
async def write(key: str, request: Request):
    text = (await request.json())["text"]
    hash = hashlib.sha256(key.encode()).hexdigest()
    with open(f"blobs/{hash}.html", "w") as file:
        file.write(text)
    return {"hash": hash}


@app.put("/hash")
async def write(request: Request):
    text = (await request.json())["text"]
    hash = hashlib.sha256(text.encode()).hexdigest()
    return {"hash": hash}


@app.delete("/kv/{key}")
def delete(key: str):
    db = load_db()
    db.pop(key, None)
    save_db(db)
    return {"ok": True}


@app.get("/kv")
def list_all():
    return load_db()


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=10152)