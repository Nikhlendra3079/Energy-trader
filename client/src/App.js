import { useState } from "react";
import { ethers } from "ethers";
import "./App.css";

function App() {
  const [account, setAccount] = useState(null);
  const [amount, setAmount] = useState("");
  const [type, setType] = useState("OG (Solar)");
  const [status, setStatus] = useState("");
  const [logs, setLogs] = useState([]);

  // 1. Connect Wallet (MetaMask)
  const connectWallet = async () => {
    if (window.ethereum) {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      setAccount(await signer.getAddress());
    } else {
      alert("Please install MetaMask!");
    }
  };

  // 2. Send Trade to Python AI
  const sellEnergy = async () => {
    if (!account) return alert("Connect Wallet first!");
    setStatus("Analysing weather...");

    try {
      const response = await fetch("http://127.0.0.1:8000/submit_trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seller: account,
          amount: parseInt(amount),
          type: type,
        }),
      });

      const data = await response.json();
      
      if (data.status === "Rejected") {
        setStatus(`❌ REJECTED: ${data.reason}`);
        addLog(`🛑 Fraud Attempt Blocked: ${data.reason}`);
      } else {
        setStatus(`✅ APPROVED & QUEUED (Weather: ${data.weather})`);
        addLog(`hz Queued: ${amount}kWh (${type}) - Waiting for Batch...`);
      }
    } catch (error) {
      console.error(error);
      setStatus("Error connecting to AI Server");
    }
  };

  const addLog = (msg) => setLogs((prev) => [msg, ...prev]);

  return (
    <div style={{ padding: "50px", fontFamily: "Arial", maxWidth: "600px", margin: "auto" }}>
      <h1>⚡ Energy Trading Portal</h1>
      
      {/* Wallet Connection */}
      {!account ? (
        <button onClick={connectWallet} style={styles.button}>Connect Wallet</button>
      ) : (
        <p>👤 User: <strong>{account.slice(0, 6)}...{account.slice(-4)}</strong></p>
      )}

      {/* Trade Form */}
      <div style={styles.card}>
        <h3>Sell Energy</h3>
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

        <button onClick={sellEnergy} style={styles.greenButton}>Submit to AI Oracle</button>
      </div>

      {/* Status & Logs */}
      <h3>Status: {status}</h3>
      <div style={styles.logBox}>
        {logs.map((log, i) => <p key={i} style={{margin: "5px 0"}}>{log}</p>)}
      </div>
    </div>
  );
}

const styles = {
  card: { border: "1px solid #ddd", padding: "20px", borderRadius: "10px", marginTop: "20px" },
  input: { display: "block", width: "100%", padding: "10px", margin: "10px 0", fontSize: "16px" },
  button: { padding: "10px 20px", fontSize: "16px", cursor: "pointer", backgroundColor: "#007bff", color: "white", border: "none", borderRadius: "5px" },
  greenButton: { padding: "10px 20px", fontSize: "16px", cursor: "pointer", backgroundColor: "#28a745", color: "white", border: "none", borderRadius: "5px", width: "100%" },
  logBox: { background: "#f8f9fa", padding: "15px", borderRadius: "5px", height: "200px", overflowY: "scroll", border: "1px solid #ccc" }
};

export default App;