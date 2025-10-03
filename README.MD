# puppeteer-render

Render web pages and interact with elements via a simple HTTP API.

**Examples:**

curl.exe -X POST http://localhost:3000/render -H "Content-Type: application/json" -d "{\"url\":\"https://google.com/...\",\"click\":{\"type\":\"attr\",\"name\":\"data-tab\",\"value\":\"data\"}}"


curl.exe -X POST http://localhost:3000/render -H "Content-Type: application/json" -d "{\"url\":\"https://google.com/...\",\"clicks\":[{\"type\":\"css\",\"selector\":\".js-data\"}]}"
