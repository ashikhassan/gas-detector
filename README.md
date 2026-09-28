# 🛡️ AegisGas IoT: ESP32 Smart Gas Detection & Meta WhatsApp Cloud Alert System

An end-to-end IoT safety system combining **ESP32**, **MQ Gas Sensor**, **Meta WhatsApp Cloud API**, and a real-time **Node.js Web Dashboard** with dynamic threshold tuning, live charts, and incident logging.

---

## 📌 Features

- **Real-Time Gas Monitoring**: Fast 4-sample averaged ADC reading from the MQ gas sensor on ESP32 (GPIO 36).
- **Dual Response Alarm**:
  - 🚨 **Local Hardware Alarm**: Active Buzzer (GPIO 12) + Alert LED (GPIO 13) pulsating alarm.
  - 📱 **Remote WhatsApp Cloud API**: Automated message dispatch to user's phone via Meta Graph API v23.0 using approved templates.
- **Dynamic Threshold Control**: Set and tweak gas alarm thresholds on the fly from the web dashboard without re-flashing the ESP32.
- **Live Cyber-Industrial Dashboard**:
  - Circular animated radial gauge.
  - Real-time time-series trend line chart with threshold boundary.
  - Web Audio alarm synthesizer.
  - Hardware pin status indicators (Buzzer, LED, Wi-Fi RSSI).
  - Emergency buzzer mute override.
  - Interactive simulator to demo gas leak triggers without physical gas.
  - WhatsApp test messenger to verify Meta credentials instantly.
  - Full historical incident timeline.

---

## 🔌 Hardware Wiring Diagram

| Component | Pin / Terminal | ESP32 GPIO | Notes |
|---|---|---|---|
| **MQ Gas Sensor** | VCC | 5V / VIN | MQ sensors require 5V for heater |
| **MQ Gas Sensor** | GND | GND | Common ground |
| **MQ Gas Sensor** | AO (Analog Out) | **GPIO 36 (VP)** | ADC1 channel (0 - 4095) |
| **Active Buzzer** | Positive (+) | **GPIO 12** | Local alarm |
| **Active Buzzer** | Negative (-) | GND | Ground |
| **Alert LED** | Anode (+) | **GPIO 13** | Use 220Ω - 330Ω resistor |
| **Alert LED** | Cathode (-) | GND | Ground |

---

## 🚀 Quick Start Guide

### Step 1: Start the Node.js Backend & Dashboard

1. Open your terminal and navigate to the backend folder:
   ```bash
   cd /Users/ashik/Project/IoT/gas-detector/backend
   npm install
   npm start
   ```
2. Open your browser and go to:
   ```
   http://localhost:3000
   ```

---

### Step 2: Configure Meta WhatsApp Cloud API

1. Visit [Meta for Developers](https://developers.facebook.com/).
2. Create or open your **Business App** &rarr; Add **WhatsApp** product.
3. In the left sidebar, navigate to **WhatsApp** &rarr; **API Setup**:
   - Copy **Temporary Access Token** (or generate a permanent System User Token).
   - Copy **Phone Number ID**.
   - Add your recipient phone number to the test recipient list and verify via OTP.
4. **Create Message Templates** in *WhatsApp Manager &rarr; Message Templates*:
   - **Template 1 (`gas_alert`)**:
     ```
     🚨 Gas Leak Alert! Gas level: {{1}} Alarm threshold: {{2}} Please check the area immediately.
     ```
   - **Template 2 (`gas_recovered`)**:
     ```
     ✅ Gas level has returned to normal. Current gas level: {{1}} Alarm threshold: {{2}} The gas alarm has been cleared.
     ```
5. Enter your credentials either into `backend/.env` or click the ⚙️ **Settings** icon on the web dashboard to save them instantly.

---

### Step 3: Flash the ESP32

1. Open `sketch_sep25a/sketch_sep25a.ino` in Arduino IDE.
2. Install the **ESP32** board package in Arduino IDE (if not already installed).
3. Configure your Wi-Fi credentials and Node backend IP in the sketch:
   ```cpp
   const char* ssid     = "YOUR_WIFI_NAME";
   const char* password = "YOUR_WIFI_PASSWORD";
   const char* nodeServerHost = "http://YOUR_COMPUTER_LOCAL_IP:3000";
   ```
4. Select your ESP32 board and COM/Serial port &rarr; Click **Upload**.
5. Open Serial Monitor at **115200 baud** to verify Wi-Fi connection and live sensor streaming.

---

## 📡 REST & WebSocket API Endpoints

- `GET /api/status` - Complete device and configuration status.
- `POST /api/telemetry` - Ingestion endpoint for ESP32 readings.
- `GET /api/config` - Fetches dynamic threshold and settings for ESP32.
- `POST /api/config/threshold` - Update gas threshold value.
- `POST /api/config/settings` - Update WhatsApp credentials and behavior.
- `POST /api/whatsapp/test` - Trigger manual WhatsApp test message.
- `POST /api/simulate` - Simulate gas leak values for demonstration.
- `GET /api/alerts` - Incident logs history.
- `DELETE /api/alerts` - Clear incident logs.
- `GET /api/history` - Recent sensor time-series data.
