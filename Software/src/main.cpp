#include <Arduino.h>
#include <WiFi.h>
#include "esp_camera.h"
#include "driver/i2s.h"
#include "esp_http_server.h"
#include <WebSocketsClient.h>

// ------------------------------------------------------------------
// CONFIGURATION-uses your home or private LAN wifi---you could reconfigure to use the ESP32's own Wifi if you want.
// ------------------------------------------------------------------
#define WIFI_SSID       "Your Wifi Username"
#define WIFI_PASSWORD   "WIFI_password"

// Replace with your PC's IP address where server.py is running
#define SERVER_HOST     "192.168.1.170"             //private IP, not public Ip addr
#define SERVER_PORT     8000
#define WS_PATH         "/ws/audio"

// OV3660 CAMERA PINOUT
#define PWDN_GPIO_NUM     -1
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      15
#define SIOD_GPIO_NUM       4
#define SIOC_GPIO_NUM       5
#define Y9_GPIO_NUM        16
#define Y8_GPIO_NUM        17
#define Y7_GPIO_NUM        18
#define Y6_GPIO_NUM        12
#define Y5_GPIO_NUM        10
#define Y4_GPIO_NUM         8
#define Y3_GPIO_NUM         9
#define Y2_GPIO_NUM        11
#define VSYNC_GPIO_NUM      6
#define HREF_GPIO_NUM       7
#define PCLK_GPIO_NUM      13

// AUDIO HARDWARE PINOUT
#define MIC_I2S     I2S_NUM_0
#define MIC_SCK     2
#define MIC_WS      1
#define MIC_SD      42

#define SPK_I2S     I2S_NUM_1
#define SPK_BCLK    40
#define SPK_LRC     41
#define SPK_DIN     39

// AUDIO PARAMETERS
#define SAMPLE_RATE         16000
#define BUFFER_SIZE         512
#define MIC_TO_PHONE_GAIN  0.030f
#define SPEAKER_GAIN 0.40f

#define CAMERA_HTTP_PORT    8080

// ------------------------------------------------------------------
// GLOBAL OBJECTS & STATE
// ------------------------------------------------------------------
httpd_handle_t cameraHttpServer = nullptr;
WebSocketsClient webSocket;
bool wsConnected = false;

#define RX_RING_SAMPLES 8192
int16_t rxRing[RX_RING_SAMPLES];
volatile size_t rxHead = 0;
volatile size_t rxTail = 0;
portMUX_TYPE rxMux = portMUX_INITIALIZER_UNLOCKED;

int32_t micBuffer[BUFFER_SIZE];
int16_t phoneBuffer[BUFFER_SIZE];

// ------------------------------------------------------------------
// RING BUFFER FUNCTIONS
// ------------------------------------------------------------------
size_t rxWrite(const uint8_t *data, size_t length) {
    size_t samples = length / sizeof(int16_t);
    size_t written = 0;

    portENTER_CRITICAL(&rxMux);
    while (written < samples) {
        size_t next = (rxHead + 1) % RX_RING_SAMPLES;
        if (next == rxTail) break;

        int16_t sample;
        memcpy(&sample, data + written * sizeof(int16_t), sizeof(int16_t));
        rxRing[rxHead] = sample;
        rxHead = next;
        written++;
    }
    portEXIT_CRITICAL(&rxMux);
    return written;
}

size_t rxRead(int16_t *out, size_t maxSamples) {
    size_t count = 0;
    portENTER_CRITICAL(&rxMux);
    while (count < maxSamples && rxTail != rxHead) {
        out[count++] = rxRing[rxTail];
        rxTail = (rxTail + 1) % RX_RING_SAMPLES;
    }
    portEXIT_CRITICAL(&rxMux);
    return count;
}

// ------------------------------------------------------------------
// HARDWARE INITIALIZATION
// ------------------------------------------------------------------
bool initCamera() {
    camera_config_t config = {};
    config.ledc_channel = LEDC_CHANNEL_0;
    config.ledc_timer = LEDC_TIMER_0;
    config.pin_d0 = Y2_GPIO_NUM;
    config.pin_d1 = Y3_GPIO_NUM;
    config.pin_d2 = Y4_GPIO_NUM;
    config.pin_d3 = Y5_GPIO_NUM;
    config.pin_d4 = Y6_GPIO_NUM;
    config.pin_d5 = Y7_GPIO_NUM;
    config.pin_d6 = Y8_GPIO_NUM;
    config.pin_d7 = Y9_GPIO_NUM;
    config.pin_xclk = XCLK_GPIO_NUM;
    config.pin_pclk = PCLK_GPIO_NUM;
    config.pin_vsync = VSYNC_GPIO_NUM;
    config.pin_href = HREF_GPIO_NUM;
    config.pin_sccb_sda = SIOD_GPIO_NUM;
    config.pin_sccb_scl = SIOC_GPIO_NUM;
    config.pin_pwdn = PWDN_GPIO_NUM;
    config.pin_reset = RESET_GPIO_NUM;
    config.xclk_freq_hz = 20000000;
    config.pixel_format = PIXFORMAT_JPEG;
    config.frame_size = FRAMESIZE_VGA;
    config.jpeg_quality = 12;
    config.fb_count = 2;
    config.fb_location = CAMERA_FB_IN_PSRAM;
    config.grab_mode = CAMERA_GRAB_LATEST;

    return (esp_camera_init(&config) == ESP_OK);
}

bool initMicrophone() {
    i2s_config_t config = {
        .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
        .sample_rate = SAMPLE_RATE,
        .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
        .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count = 4,
        .dma_buf_len = BUFFER_SIZE,
        .use_apll = false,
        .tx_desc_auto_clear = false,
        .fixed_mclk = 0
    };
    i2s_pin_config_t pins = {
        .bck_io_num = MIC_SCK,
        .ws_io_num = MIC_WS,
        .data_out_num = -1,
        .data_in_num = MIC_SD
    };
    if (i2s_driver_install(MIC_I2S, &config, 0, nullptr) != ESP_OK) return false;
    if (i2s_set_pin(MIC_I2S, &pins) != ESP_OK) return false;
    i2s_zero_dma_buffer(MIC_I2S);
    return true;
}

bool initSpeaker() {
    i2s_config_t config = {
        .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
        .sample_rate = SAMPLE_RATE,
        .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
        .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count = 4,
        .dma_buf_len = BUFFER_SIZE,
        .use_apll = false,
        .tx_desc_auto_clear = true,
        .fixed_mclk = 0
    };
    i2s_pin_config_t pins = {
        .bck_io_num = SPK_BCLK,
        .ws_io_num = SPK_LRC,
        .data_out_num = SPK_DIN,
        .data_in_num = -1
    };
    if (i2s_driver_install(SPK_I2S, &config, 0, nullptr) != ESP_OK) return false;
    if (i2s_set_pin(SPK_I2S, &pins) != ESP_OK) return false;
    i2s_zero_dma_buffer(SPK_I2S);
    return true;
}

// ------------------------------------------------------------------
// MJPEG HTTP SERVER HANDLER
// ------------------------------------------------------------------
static esp_err_t streamHandler(httpd_req_t *req) {
    camera_fb_t *fb = nullptr;
    esp_err_t res = ESP_OK;
    char partBuf[128];

    static const char *STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=frame";
    static const char *STREAM_BOUNDARY = "\r\n--frame\r\n";
    static const char *STREAM_PART = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

    httpd_resp_set_type(req, STREAM_CONTENT_TYPE);

    while (true) {
        fb = esp_camera_fb_get();
        if (!fb) { res = ESP_FAIL; break; }

        size_t headerLength = snprintf(partBuf, sizeof(partBuf), STREAM_PART, fb->len);
        res = httpd_resp_send_chunk(req, STREAM_BOUNDARY, strlen(STREAM_BOUNDARY));
        if (res == ESP_OK) res = httpd_resp_send_chunk(req, partBuf, headerLength);
        if (res == ESP_OK) res = httpd_resp_send_chunk(req, (const char *)fb->buf, fb->len);

        esp_camera_fb_return(fb);
        if (res != ESP_OK) break;
        delay(1);
    }
    return res;
}

bool startCameraHttpServer() {
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = CAMERA_HTTP_PORT;
    config.ctrl_port = 32770;
    config.max_open_sockets = 2;

    if (httpd_start(&cameraHttpServer, &config) == ESP_OK) {
        httpd_uri_t streamUri = {
            .uri      = "/stream",
            .method   = HTTP_GET,
            .handler  = streamHandler,
            .user_ctx = NULL
        };
        return (httpd_register_uri_handler(cameraHttpServer, &streamUri) == ESP_OK);
    }
    return false;
}

// ------------------------------------------------------------------
// WEBSOCKET CLIENT EVENTS
// ------------------------------------------------------------------
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
    switch(type) {
        case WStype_DISCONNECTED:
            wsConnected = false;
            portENTER_CRITICAL(&rxMux);
            rxHead = 0;
            rxTail = 0;
            portEXIT_CRITICAL(&rxMux);
            Serial.println("[WS] Disconnected from Python server");
            break;
        case WStype_CONNECTED:
            wsConnected = true;
            Serial.println("[WS] Connected to Python server relay");
            break;
        case WStype_BIN:
            rxWrite(payload, length);
            break;
        default:
            break;
    }
}

// ------------------------------------------------------------------
// AUDIO PROCESSORS
// ------------------------------------------------------------------
void streamMicToServer() {
    if (!wsConnected) return;

    size_t bytesRead = 0;
    esp_err_t r = i2s_read(MIC_I2S, micBuffer, sizeof(micBuffer), &bytesRead, 0);
    if (r != ESP_OK || bytesRead == 0) return;

    int samples = bytesRead / sizeof(int32_t);
    if (samples > BUFFER_SIZE) samples = BUFFER_SIZE;

    for (int i = 0; i < samples; ++i) {
        int32_t sample = micBuffer[i] >> 8;
        float scaled = sample * MIC_TO_PHONE_GAIN;
        if (scaled > 32767.0f) scaled = 32767.0f;
        if (scaled < -32768.0f) scaled = -32768.0f;
        phoneBuffer[i] = (int16_t)scaled;
    }

    webSocket.sendBIN((uint8_t *)phoneBuffer, samples * sizeof(int16_t));
}

void playIncomingAudio() {
    if (!wsConnected) return;

    int16_t samples[256];
    size_t count = rxRead(samples, 256);
    if (count == 0) return;

    int16_t stereo[512];

    for (size_t i = 0; i < count; ++i) {
        // Apply digital speaker volume/gain
        int32_t amplified = (int32_t)(samples[i] * SPEAKER_GAIN);

        // Prevent 16-bit overflow/clipping
        if (amplified > 32767) amplified = 32767;
        if (amplified < -32768) amplified = -32768;

        int16_t output = (int16_t)amplified;

        // Mono -> both MAX98357A channels
        stereo[i * 2]     = output;
        stereo[i * 2 + 1] = output;
    }

    size_t written = 0;

    i2s_write(
        SPK_I2S,
        stereo,
        count * 2 * sizeof(int16_t),
        &written,
        0
    );
}

// ------------------------------------------------------------------
// SETUP & LOOP
// ------------------------------------------------------------------
void setup() {
    Serial.begin(115200);
    delay(1000);

    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    while (WiFi.status() != WL_CONNECTED) {
        delay(250);
        Serial.print(".");
    }
    Serial.printf("\n[WIFI] Connected! IP: %s\n", WiFi.localIP().toString().c_str());

    initCamera();
    initMicrophone();
    initSpeaker();
    startCameraHttpServer();

    // Configure client connection to server.py
    webSocket.beginSSL(SERVER_HOST, SERVER_PORT, WS_PATH);
    webSocket.onEvent(webSocketEvent);
    webSocket.setReconnectInterval(2000);
}

void loop() {
    webSocket.loop();

    playIncomingAudio();
    streamMicToServer();
    delay(1);
}