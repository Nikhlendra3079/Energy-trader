import { useState, useEffect, useCallback, useRef } from "react";
import { ethers } from "ethers";
import "./App.css";

const API_BASE = process.env.REACT_APP_API_URL || "http://127.0.0.1:8000";
const HARDHAT_RPC =
  process.env.REACT_APP_HARDHAT_RPC_URL || "http://127.0.0.1:8545";
const EXPECTED_CHAIN_ID = parseInt(process.env.REACT_APP_CHAIN_ID || "31337", 10);

function getEthereumProvider() {
  if (typeof window === "undefined") return null;
  const w = window.ethereum;
  if (!w) return null;
  if (Array.isArray(w.providers) && w.providers.length > 0) {
    const mm = w.providers.find((p) => p.isMetaMask);
    return mm || w.providers[0];
  }
  return w;
}

function App() {
  const [account, setAccount] = useState(null);
  const [amount, setAmount] = useState("");
  const [type, setType] = useState("OG (Solar)");
  const [status, setStatus] = useState("");
  const [logs, setLogs] = useState([]);
  const [queueSize, setQueueSize] = useState(null);
  const [batchSize, setBatchSize] = useState(5);
  const [apiChainId, setApiChainId] = useState(EXPECTED_CHAIN_ID);
  const [walletChainId, setWalletChainId] = useState(null);
  const [lastBatch, setLastBatch] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const logIdRef = useRef(0);
  const logBoxRef = useRef(null);

  const fetchQueueStatus = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/status`);
      if (!r.ok) return;
      const d = await r.json();
      setQueueSize(typeof d.queue_size === "number" ? d.queue_size : null);
      if (typeof d.batch_size === "number" && d.batch_size > 0) {
        setBatchSize(d.batch_size);
      }
      if (typeof d.chain_id === "number" && d.chain_id > 0) {
        setApiChainId(d.chain_id);
      }
      setLastBatch(d.last_batch && typeof d.last_batch === "object" ? d.last_batch : null);
    } catch {
      setQueueSize(null);
      setLastBatch(null);
    }
  }, []);

  
  useEffect(() => {
    fetchQueueStatus();
    const id = setInterval(fetchQueueStatus, 2000);
    return () => clearInterval(id);
  }, [fetchQueueStatus]);

  
  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = 0;
  }, [logs.length]);

  const readWalletChainId = useCallback(async (ethereum) => {
    try {
      const hex = await ethereum.request({ method: "eth_chainId" });
      setWalletChainId(parseInt(hex, 16));
    } catch {
      setWalletChainId(null);
    }
  }, []);

  const refreshAccountFromProvider = useCallback(
    async (ethereum) => {
      const provider = new ethers.BrowserProvider(ethereum);
      const signer = await provider.getSigner();
      const addr = await signer.getAddress();
      setAccount(ethers.getAddress(addr));
      await readWalletChainId(ethereum);
    },
    [readWalletChainId]
  );

  
  useEffect(() => {
    const ethereum = getEthereumProvider();
    if (!ethereum) return;

    const syncIfAlreadyConnected = async () => {
      try {
        const accounts = await ethereum.request({ method: "eth_accounts" });
        if (accounts?.length) await refreshAccountFromProvider(ethereum);
      } catch (e) {
        console.error(e);
      }
    };
    syncIfAlreadyConnected();

    const onAccountsChanged = (accs) => {
      if (!accs?.length) {
        setAccount(null);
        setWalletChainId(null);
        return;
      }
      setAccount(ethers.getAddress(accs[0]));
      readWalletChainId(ethereum);
    };
    const onChainChanged = (hex) => {
      setWalletChainId(parseInt(hex, 16));
      window.location.reload();
    };
    ethereum.on?.("accountsChanged", onAccountsChanged);
    ethereum.on?.("chainChanged", onChainChanged);
    return () => {
      ethereum.removeListener?.("accountsChanged", onAccountsChanged);
      ethereum.removeListener?.("chainChanged", onChainChanged);
    };
  }, [refreshAccountFromProvider, readWalletChainId]);

  
  const connectWallet = async () => {
    const ethereum = getEthereumProvider();
    if (!ethereum) {
      window.open("https://metamask.io/download/", "_blank", "noopener,noreferrer");
      setStatus("Install a wallet (e.g. MetaMask), then refresh and try again.");
      return;
    }
    setStatus("Waiting for wallet…");
    try {
      await ethereum.request({ method: "eth_requestAccounts" });
      await refreshAccountFromProvider(ethereum);
      setStatus("");
    } catch (err) {
      console.error(err);
      if (err?.code === 4001) {
        setStatus("Connection cancelled in your wallet.");
      } else {
        setStatus(err?.message || "Could not connect wallet.");
      }
    }
  };

  /** MetaMask: add + switch to the same chain the API uses (default Hardhat 31337). */
  const addHardhatToMetaMask = async () => {
    const ethereum = getEthereumProvider();
    if (!ethereum) {
      setStatus("No wallet found.");
      return;
    }
    const targetId = apiChainId;
    const chainIdHex = "0x" + targetId.toString(16);
    setStatus("Switching network in wallet…");
    try {
      try {
        await ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: chainIdHex }],
        });
      } catch (switchErr) {
        if (switchErr?.code === 4902) {
          await ethereum.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: chainIdHex,
                chainName: "Hardhat Local",
                nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
                rpcUrls: [HARDHAT_RPC],
              },
            ],
          });
        } else {
          throw switchErr;
        }
      }
      await readWalletChainId(ethereum);
      setStatus("");
    } catch (err) {
      console.error(err);
      setStatus(err?.message || "Could not add or switch network.");
    }
  };

  const pushLog = useCallback((msg) => {
    logIdRef.current += 1;
    const id = logIdRef.current;
    setLogs((prev) => [{ id, text: msg }, ...prev]);
  }, []);

  
  const sellEnergy = async () => {
    if (!account) return alert("Connect Wallet first!");
    const kwh = parseInt(amount, 10);
    if (!Number.isFinite(kwh) || kwh <= 0) {
      setStatus("Enter a valid amount (kWh).");
      return;
    }

    setSubmitting(true);
    setStatus("Analysing weather…");

    try {
      const response = await fetch(`${API_BASE}/submit_trade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seller: account,
          amount: kwh,
          type: type,
        }),
      });

      let data;
      try {
        data = await response.json();
      } catch {
        setStatus(`Server returned a non-JSON response. Is the API running at ${API_BASE}?`);
        pushLog("⚠️ Check that `app.py` (FastAPI) is running.");
        return;
      }

      await fetchQueueStatus();

      if (data.status === "Rejected") {
        setStatus(`❌ REJECTED: ${data.reason}`);
        pushLog(`🛑 Fraud attempt blocked: ${data.reason}`);
      } else {
        const pos = data.queue_position != null ? ` (#${data.queue_position} in queue)` : "";
        setStatus(`✅ Queued${pos} · Weather: ${data.weather ?? "—"}`);
        pushLog(`✅ Queued: ${kwh} kWh (${type})${pos} `);
        setAmount("");
      }
    } catch (error) {
      console.error(error);
      setStatus("Error connecting to AI server (is it running?)");
      pushLog(`⚠️ Could not reach ${API_BASE}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ padding: "50px", fontFamily: "Arial", maxWidth: "600px", margin: "auto" }}>
      <h1>⚡ Energy Trading Portal</h1>

      <div style={styles.howItWorks}>
        <h4 style={{ margin: "0 0 8px" }}>How it works</h4>
        <ol style={{ margin: 0, paddingLeft: "1.25rem", lineHeight: 1.5, fontSize: "14px" }}>
          <li>Connect your wallet — your address identifies the seller.</li>
          <li>Submit kWh — the API checks plausibility (weather / battery limits).</li>
          <li>
            Trades queue; every {batchSize} submissions the oracle writes one Merkle batch to the chain.
          </li>
        </ol>
        
      </div>

      {/* Wallet Connection */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center" }}>
        {!account ? (
          <button type="button" onClick={connectWallet} style={styles.button}>
            Connect Wallet
          </button>
        ) : (
          <p style={{ margin: 0 }}>
            User: <strong>{account.slice(0, 6)}...{account.slice(-4)}</strong>
          </p>
        )}
        {getEthereumProvider() && (
          <button type="button" onClick={addHardhatToMetaMask} style={styles.buttonSecondary}>
            Switch Hardhat 
          </button>
        )}
      </div>
      {account && walletChainId != null && walletChainId !== apiChainId && (
        <p style={styles.networkWarn}>
          Wallet is on chain <strong>{walletChainId}</strong> but the API uses <strong>{apiChainId}</strong>.
          Use the button above to switch.
        </p>
      )}

      {/* Trade Form */}
      <div style={styles.card}>
        <h3>Sell Energy</h3>
        <p style={styles.queueHint}>
          Batch queue:{" "}
          <strong>
            {queueSize == null ? "…" : `${queueSize} / ${batchSize}`}
          </strong>
          {queueSize != null && queueSize >= batchSize ? " (flushing…)" : ""}
        </p>
        <input 
          type="number" 
          placeholder="Amount (kWh)" 
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          style={styles.input}
        />
        
        <select value={type} onChange={(e) => setType(e.target.value)} style={styles.input}>
          <option value="OG (Solar)">Solar Generation</option>
          <option value="ES (Battery)">Battery Discharge</option>
        </select>

        <button
          type="button"
          onClick={sellEnergy}
          disabled={submitting}
          style={{
            ...styles.greenButton,
            opacity: submitting ? 0.7 : 1,
            cursor: submitting ? "wait" : "pointer",
          }}
        >
          {submitting ? "Submitting…" : "Submit to AI Oracle"}
        </button>
      </div>

      {/* Status & Logs */}
      <h3>Status: {status || "—"}</h3>

      {(lastBatch?.tx_hash || lastBatch?.error) && (
        <div style={styles.batchPanel}>
          <strong>Last on-chain batch</strong>
          {lastBatch.tx_hash && (
            <p style={{ margin: "6px 0", wordBreak: "break-all", fontFamily: "monospace", fontSize: "13px" }}>
              Tx: {lastBatch.tx_hash}
            </p>
          )}
          {lastBatch.trade_count != null && (
            <p style={{ margin: "4px 0", fontSize: "14px" }}>
              Trades: {lastBatch.trade_count}
              {lastBatch.total_value_wei != null ? ` · Value (wei): ${lastBatch.total_value_wei}` : ""}
            </p>
          )}
          {lastBatch.submitted_at && (
            <p style={{ margin: "4px 0", fontSize: "12px", color: "#666" }}>{lastBatch.submitted_at}</p>
          )}
          {lastBatch.error && (
            <p style={{ margin: "6px 0 0", color: "#b00020", fontSize: "14px" }}>Error: {lastBatch.error}</p>
          )}
        </div>
      )}

      <div ref={logBoxRef} style={styles.logBox}>
        {logs.length === 0 ? (
          <p style={{ margin: "5px 0", color: "#888" }}>Activity will appear here after you submit.</p>
        ) : (
          logs.map((log) => (
            <p key={log.id} style={{ margin: "5px 0" }}>
              {log.text}
            </p>
          ))
        )}
      </div>
    </div>
  );
}

const styles = {
  networkWarn: {
    marginTop: "10px",
    padding: "10px 12px",
    background: "#fff3e0",
    border: "1px solid #ffcc80",
    borderRadius: "6px",
    fontSize: "14px",
  },
  buttonSecondary: {
    padding: "10px 16px",
    fontSize: "14px",
    cursor: "pointer",
    backgroundColor: "#6c757d",
    color: "white",
    border: "none",
    borderRadius: "5px",
  },
  howItWorks: {
    background: "#f0f7ff",
    border: "1px solid #cfe8ff",
    borderRadius: "8px",
    padding: "14px 16px",
    marginBottom: "20px",
  },
  batchPanel: {
    border: "1px solid #ccc",
    borderRadius: "8px",
    padding: "12px 14px",
    marginBottom: "16px",
    background: "#fafafa",
  },
  queueHint: { margin: "0 0 10px", fontSize: "15px", color: "#333" },
  card: { border: "1px solid #ddd", padding: "20px", borderRadius: "10px", marginTop: "20px" },
  input: { display: "block", width: "100%", padding: "10px", margin: "10px 0", fontSize: "16px" },
  button: { padding: "10px 20px", fontSize: "16px", cursor: "pointer", backgroundColor: "#007bff", color: "white", border: "none", borderRadius: "5px" },
  greenButton: { padding: "10px 20px", fontSize: "16px", cursor: "pointer", backgroundColor: "#28a745", color: "white", border: "none", borderRadius: "5px", width: "100%" },
  logBox: { background: "#f8f9fa", padding: "15px", borderRadius: "5px", height: "200px", overflowY: "scroll", border: "1px solid #ccc" }
};

export default App;