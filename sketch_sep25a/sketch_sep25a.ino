#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

// Wi-Fi Credentials
const char *ssid = "moto edge 60 pro_4790";
const char *password = "0987654321";

// Backend (Node.js) base URL. WhatsApp alerts are sent by the backend.
// Local:  "http://192.168.x.x:3000"   Remote: "https://your-domain.com"
const String serverUrl = "http://72.60.211.81";

// Pin Definitions
const int mqPin = 36;     // VP pin (GPIO 36)
const int buzzerPin = 12; // D12 pin
const int ledPin = 13;    // D13 pin

// Dynamic Gas Alarm Threshold (synced from backend)
int gasThreshold = 2000;
bool buzzerMuted = false;

bool alarmActive = false;
unsigned long previousBlinkMillis = 0;
unsigned long lastTelemetry = 0;
unsigned long lastConfigSync = 0;
const unsigned long telemetryInterval = 2000;
const unsigned long configInterval = 5000;

// Begin an HTTP request (HTTP or HTTPS) against the backend.
WiFiClientSecure secureClient;
WiFiClient plainClient;
HTTPClient http;

bool beginRequest(const String &path) {
  String url = serverUrl + path;
  http.setTimeout(3000);
  if (url.startsWith("https://")) {
    secureClient.setInsecure();
    return http.begin(secureClient, url);
  }
  return http.begin(plainClient, url);
}

void sendTelemetry(int gasValue) {
  if (WiFi.status() != WL_CONNECTED || !beginRequest("/api/telemetry"))
    return;

  JsonDocument doc;
  doc["gasValue"] = gasValue;
  doc["buzzerState"] = digitalRead(buzzerPin);
  doc["ledState"] = digitalRead(ledPin);
  doc["ip"] = WiFi.localIP().toString();
  doc["rssi"] = WiFi.RSSI();
  doc["uptime"] = millis() / 1000;

  String body;
  serializeJson(doc, body);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  if (code <= 0) {
    Serial.println("Telemetry failed: " + http.errorToString(code));
  }
  http.end();
}

void syncConfig() {
  if (WiFi.status() != WL_CONNECTED || !beginRequest("/api/config"))
    return;

  int code = http.GET();
  if (code == 200) {
    JsonDocument doc;
    if (!deserializeJson(doc, http.getString())) {
      gasThreshold = doc["threshold"] | gasThreshold;
      buzzerMuted = doc["buzzerMuted"] | false;
    }
  }
  http.end();
}

void setup() {
  Serial.begin(115200);

  pinMode(buzzerPin, OUTPUT);
  pinMode(ledPin, OUTPUT);

  // 1. Power On Signal: 2-second long beep
  digitalWrite(buzzerPin, HIGH);
  digitalWrite(ledPin, HIGH);
  delay(2000);
  digitalWrite(buzzerPin, LOW);
  digitalWrite(ledPin, LOW);

  // 2. Wi-Fi Connection
  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("\nWi-Fi Connected!");

  // 3. Network Connected Signal: 2 short beeps
  for (int i = 0; i < 2; i++) {
    digitalWrite(buzzerPin, HIGH);
    digitalWrite(ledPin, HIGH);
    delay(100);
    digitalWrite(buzzerPin, LOW);
    digitalWrite(ledPin, LOW);
    delay(100);
  }

  syncConfig();
}

void loop() {
  int gasValue = analogRead(mqPin);

  Serial.print("Gas Level: ");
  Serial.println(gasValue);

  // Push reading to backend (backend sends WhatsApp alerts)
  if (millis() - lastTelemetry >= telemetryInterval) {
    lastTelemetry = millis();
    sendTelemetry(gasValue);
  }

  // Pull threshold / settings from backend
  if (millis() - lastConfigSync >= configInterval) {
    lastConfigSync = millis();
    syncConfig();
  }

  // Emergency Alert Condition
  if (gasValue > gasThreshold) {
    alarmActive = true;
    // Emergency Pulsing Beep (200ms ON / 200ms OFF)
    unsigned long currentMillis = millis();
    if (currentMillis - previousBlinkMillis >= 200) {
      previousBlinkMillis = currentMillis;

      int state = digitalRead(ledPin);
      digitalWrite(buzzerPin, buzzerMuted ? LOW : !state);
      digitalWrite(ledPin, !state);
    }
  } else if (alarmActive) {
    // Reset indicators when gas drops below threshold
    digitalWrite(buzzerPin, LOW);
    digitalWrite(ledPin, LOW);
    alarmActive = false;
  }
}
