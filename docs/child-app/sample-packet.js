// data/sample-packet.js
// Bundled sample packet fixture. Dates roll automatically at load time:
// day 1 is always device-local "yesterday" and day 2 is always "today",
// so 'Load sample' has something due no matter when this is opened.
(function () {
  function isoDate(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }
  function stamp(d, timeStr) {
    return isoDate(d) + "T" + timeStr + "Z";
  }

  var today = new Date();
  var yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  var generatedDay = new Date(yesterday);
  generatedDay.setDate(generatedDay.getDate() - 1);

  var todayISO = isoDate(today);
  var yesterdayISO = isoDate(yesterday);
  var todayTag = todayISO.replace(/-/g, "");
  var yesterdayTag = yesterdayISO.replace(/-/g, "");

  window.EMBEDDED_SAMPLE = {
    "schemaVersion": 1,
    "childId": "child-ada-001",
    "childName": "Ada",
    "semesterLabel": "Fall 2026",
    "generatedAt": stamp(generatedDay, "14:32:00"),
    "coversFrom": yesterdayISO,
    "coversTo": todayISO,
    "days": [
      {
        "date": yesterdayISO,
        "activities": [
          {
            "id": "SAXMATH5-f3k9-L03-02",
            "activityType": "Reading Pages",
            "title": "Lesson 3 Reading",
            "required": true,
            "payload": {
              "kind": "pageRange",
              "pageRangeStart": 22,
              "pageRangeEnd": 27
            },
            "difficultyTier": "D02",
            "rewardCategoryId": "R02",
            "courseName": "Saxon Math 5",
            "capturesGrade": false,
            "expectedDurationMin": 20,
            "blockHint": "morning",
            "lessonTitle": "Multiplying Fractions",
            "instructions": "Read carefully and work the examples in your head before checking the answer key."
          },
          {
            "id": "SAXMATH5-f3k9-L03-03",
            "activityType": "Quiz",
            "title": "Lesson 3 Quiz",
            "required": true,
            "payload": {
              "kind": "reference",
              "reference": "Saxon Math 5 - Unit 2 - Quiz 3"
            },
            "difficultyTier": "D03",
            "rewardCategoryId": "R03",
            "courseName": "Saxon Math 5",
            "capturesGrade": true,
            "blockHint": "morning",
            "sequenceNumber": 1,
            "lessonTitle": "Multiplying Fractions"
          },
          {
            "id": "MIAHIST3-k7q2-L01-01",
            "activityType": "Practice Level",
            "title": "Timeline Practice",
            "required": false,
            "payload": {
              "kind": "none"
            },
            "difficultyTier": "D01",
            "rewardCategoryId": "R01",
            "courseName": "MiAcademy History",
            "capturesGrade": false,
            "sequenceNumber": 4,
            "lessonTitle": "Ancient Civilizations",
            "blockHint": "afternoon"
          },
          {
            "id": "HOMEART1-p8j5-L02-01",
            "activityType": "Sketchbook Page",
            "title": "Draw a Still Life",
            "required": false,
            "payload": {
              "kind": "freeText",
              "text": "Set up three objects on the kitchen table and sketch them from one angle."
            },
            "difficultyTier": "D01",
            "rewardCategoryId": "R01",
            "courseName": "Homemade Art Study",
            "capturesGrade": false,
            "blockHint": "afternoon"
          }
        ],
        "chores": [
          {
            "id": "CHR-b4n1-" + yesterdayTag,
            "choreType": "Kitchen/Dining",
            "title": "Unload dishwasher",
            "date": yesterdayISO,
            "difficultyTier": "D01",
            "rewardCategoryId": "R01",
            "required": true,
            "blockHint": "morning"
          }
        ],
        "events": [
          {
            "id": "EVT-t9x2",
            "title": "Piano recital",
            "startDate": yesterdayISO,
            "endDate": yesterdayISO,
            "time": "16:30",
            "notes": "Bring the black folder."
          }
        ]
      },
      {
        "date": todayISO,
        "activities": [],
        "chores": [
          {
            "id": "CHR-b4n1-" + todayTag,
            "choreType": "Kitchen/Dining",
            "title": "Unload dishwasher",
            "date": todayISO,
            "difficultyTier": "D01",
            "rewardCategoryId": "R01",
            "required": true,
            "blockHint": "morning"
          },
          {
            "id": "CHR-r2w8-" + todayTag,
            "choreType": "Living/Main Area",
            "title": "Water the garden",
            "date": todayISO,
            "difficultyTier": "D02",
            "rewardCategoryId": "R02",
            "required": true,
            "notes": "Extra water on the tomatoes.",
            "blockHint": "afternoon"
          }
        ],
        "events": []
      }
    ]
  };
})();
