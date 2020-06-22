const fs = require('fs');
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const {
    PubSub
} = require('@google-cloud/pubsub');
const {
    Storage
} = require('@google-cloud/storage');
const tmp = require('tmp');
const {
    google
} = require('googleapis');
const healthcare = google.healthcare('v1');
const storage = new Storage();
const pubSubClient = new PubSub();
const projectId = 'jpa-healthcare-demo';

//In a dev environment all params can be provided in a params file instead of environment variables
var appParams = {}
try {
 appParams = require('../../params.json');
 console.log("Using application file parameters");
} catch (err) {console.log("Params not loaded, using env variables");}
const subscriptionName = process.env.SUBSCRIPTION_NAME || appParams.SUBSCRIPTION_NAME;
const inference_dicom_store_name = process.env.INFERENCE_DICOM_STORE || appParams.INFERENCE_DICOM_STORE;
const ipaddr = process.env.IPADDR || appParams.IPADDR;
if (appParams.keyFilename) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = appParams.keyFilename;
}
//=========== HTTPSEVER CODE ===========
var app = express();
app.use(bodyParser.json());

//this allows us to insert runtime variables into the client side javascript code
app.get("/public/js/app.js", function(req, res) {
    fs.readFile(path.join(__dirname, 'public', 'js', 'app.js'), 'utf8', function(err, data) {
        if (err) {
            res.sendStatus(404);
        } else {
            // modify the data here, then send it
            data = data.replace(/IPADDR/g, ipaddr);
            res.send(data);
        }
    });
});

// Serve static assets from the /public folder
app.use('/public', express.static(path.join(__dirname, '/public')));
app.get('/', function(req, res) {
    console.log('retrieve homepage');
    res.sendFile(path.join(__dirname, '/public/index.html'));
});

//ENDPOINT FOR DICOM IMAGE
app.get('/dicomImage', function(req, res) {
    console.log('retrieve dicom image ' + req.query.studyId + '/' + req.query.seriesId + '/' + req.query.instanceId);

    _dicomWebRetrieveRendered(req.query.studyId, req.query.seriesId, req.query.instanceId).then(function(rendered) {
        res.contentType('image/png');
        res.end(rendered, 'binary');
    })
});

//ENDPOINT FOR DICOM INSTANCE
app.get('/dicomInstance', function(req, res) {
    console.log('retrieve dicom instance ' + req.query.studyId + '/' + req.query.seriesId + '/' + req.query.instanceId);

    _dicomWebRetrieveInstance(req.query.studyId, req.query.seriesId, req.query.instanceId).then(function(rendered) {
        res.contentType('application/dicom');
        res.end(rendered, 'binary');
    })
});

//util to clear locks (locking isn't watertight for this demo - so just in case..)
app.get('/clearLocks', function(req, res) {
  console.log('Clearing all locks');
  requestsLock.clear();
  res.end("OK");
});

var port = process.env.PORT || 8080;
var httpServer = require('http').createServer(app);
httpServer.listen(port, function() {
    console.log('server running on port ' + port + '.');
});

//=========== WEBSOCKET CODE ===========
const wss = new WebSocket.Server({
    server: httpServer,
    path: '/ws'
});

//Poor mans's locking mechanism you would need something more robust for any prod solution
const requestsLock = new Map();

wss.on('connection', function connection(ws, req) {
    var id = req.headers['sec-websocket-key'];
    //console.log(id);
    ws.on('open', function(message, req) {
        console.log('open: %s', message);
        ws.send('Open for business');
    });
    ws.on('error', function(message) {
        console.log(message);
    });

    ws.on('message', function(message) {
        console.log('Received: %s', message);

        var msg = JSON.parse(message);

        if (msg.type === 'INSERT') {
          processInsert(ws, msg).catch( err => handleError(ws, err));
        } else if (msg.type === 'DELETE') {
          _dicomWebDeleteStudy(msg.key).catch( err => handleError(ws, err));
        } else {
            console.log('Invalid message type');
        }
    });
})

function handleError(ws, err) {
  console.log(err);
  _sendErrorMessage(ws, err);
}

async function processInsert(ws,msg) {

  var insertContext = {};
  var sourceInstance = {};
  insertContext.sourceInstance = sourceInstance;


  var dicomParams = msg.gcsUri.split('/');

  //expecting something like : gs://gcs-public-data--healthcare-tcia-cbis-ddsm/dicom/1.3.6.1.4.1.9590.100.1.2.100052171312354035019149694722933145864/1.3.6.1.4.1.9590.100.1.2.122021886313853636738943991213171853079/1.3.6.1.4.1.9590.100.1.2.143025478211711725141987429563024371610.dcm
  var bucketName = dicomParams[2];
  sourceInstance.studyId = dicomParams[4];
  sourceInstance.seriesId = dicomParams[5];
  sourceInstance.instanceId = dicomParams[6].slice(0, -4);
  var sourceFilename = path.join("dicom", dicomParams[4], dicomParams[5], dicomParams[6]);
  var lockKey = path.join(sourceInstance.studyId , sourceInstance.seriesId, sourceInstance.instanceId);
  if (!requestsLock.get(lockKey)) {
    requestsLock.set(lockKey, ws);
  } else {
    _sendLogMessage(ws, 'File already being processed. Cleanup or try another file.');
    return;
  }

  let destFilename = tmp.tmpNameSync();
  _sendLogMessage(ws, 'Downloading File..');
  await _downloadFile(destFilename, bucketName, sourceFilename);
  _sendLogMessage(ws, 'File downloaded, storing into Dicom store...');
  await _dicomWebStoreInstance(destFilename, ws);
  _sendLogMessage(ws, 'Dicom store complete, waiting for inference notification');
  _listenForMessages(insertContext);
}

//=========== PUBUSUB CODE ===========
const timeout = 60; //seconds
//NOTE: THIS IS CLEARLY DOES NOT WORK FOR MULTIPLE USERS!
function _listenForMessages(insertContext) {
    console.log('_listenForMessages');
    // References an existing subscription
    const subscription = pubSubClient.subscription(subscriptionName);

    // Create an event handler to handle messages
    let messageCount = 0;
    const messageHandler = message => {
        console.log(`Received message ${message.id}:`);
        console.log(`\tData: ${message.data}`);
        console.log(`\tAttributes: ${message.attributes}`);
        messageCount += 1;

        var inferenceNotification = JSON.parse(message.data);
        var lockKeyData = inferenceNotification.basePath.split('/');
        var lockKey = path.join(lockKeyData[10], lockKeyData[12], lockKeyData[14]);
        var ws = requestsLock.get(lockKey);
        if (ws){

          _sendLogMessage(ws, 'Inference complete!');

          var params = (inferenceNotification.reportPath).split('/');
          var inferenceInstance = {};
          inferenceInstance.studyId = params[10];
          inferenceInstance.seriesId = params[12];
          inferenceInstance.instanceId = params[14];
          insertContext.inferenceInstance = inferenceInstance;

          _sendAppMessage(ws, 'INFERENCE_COMPLETE', insertContext);

        } else {
          console.log('ignoring msg');
        }
        message.ack();
    };
    // Listen for new messages until timeout is hit
    subscription.on('message', messageHandler);

    setTimeout(() => {
        subscription.removeListener('message', messageHandler);
        console.log(`${messageCount} message(s) received.`);
    }, timeout * 1000);
}

//=========== GC STORAGE CODE ===========
async function _downloadFile(destFilename, bucketName, srcFilename) {
    console.log('_downloadFile');

    const options = {
        // The path to which the file should be downloaded, e.g. "./file.txt"
        destination: destFilename,
        userProject: projectId,
    };
    await storage.bucket(bucketName).file(srcFilename).download(options);
    console.log(
        `gs://${bucketName}/${srcFilename} downloaded to ${destFilename}.`
    );
}

//=========== DICOM STORE CODE ===========
async function _dicomWebStoreInstance(filename) {
    console.log('_dicomWebStoreInstance : ' + filename);

    const binaryData = fs.createReadStream(filename);
    const auth = await google.auth.getClient({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });

    google.options({
        auth,
        headers: {
            'Content-Type': 'application/dicom',
            Accept: 'application/dicom+json',
        },
    });

    const parent = inference_dicom_store_name;
    const dicomWebPath = 'studies';
    const request = {
        parent,
        dicomWebPath,
        requestBody: binaryData,
    };

    const instance = await healthcare.projects.locations.datasets.dicomStores.storeInstances(
        request
    );
    console.log('Stored DICOM instance:\n', JSON.stringify(instance.data));
};

async function _dicomWebDeleteStudy(key) {
    console.log('_dicomWebDeleteStudy : ' + key);

    var lockKeyData = key.split('/');
    const auth = await google.auth.getClient({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    google.options({
        auth
    });

    const parent = inference_dicom_store_name;
    const dicomWebPath = 'studies/' + lockKeyData[0];
    const request = {
        parent,
        dicomWebPath
    };

    requestsLock.delete(key);

    await healthcare.projects.locations.datasets.dicomStores.studies.delete(
        request
    );

    console.log('Deleted DICOM study');
};

async function _dicomWebRetrieveRendered(studyId, seriesId, instanceId) {
    console.log('_dicomWebRetrieveRendered');

    const auth = await google.auth.getClient({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    google.options({
        auth,
        headers: {
            Accept: 'image/png'
        },
        responseType: 'arraybuffer',
    });

    const parent = inference_dicom_store_name;
    const dicomWebPath = `studies/${studyId}/series/${seriesId}/instances/${instanceId}/rendered`;
    const request = {
        parent,
        dicomWebPath
    };

    const rendered = await healthcare.projects.locations.datasets.dicomStores.studies.series.instances.retrieveRendered(
        request
    );
    const fileBytes = Buffer.from(rendered.data);

    console.log(
        'Retrieved rendered image'
    );
    return fileBytes;
};

async function _dicomWebRetrieveInstance(studyId, seriesId, instanceId) {
    console.log('_dicomWebRetrieveInstance');

    const auth = await google.auth.getClient({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    google.options({
        auth,
        headers: {
            Accept: 'application/dicom; transfer-syntax=*'
        },
        responseType: 'arraybuffer',
    });

    const parent = inference_dicom_store_name;
    const dicomWebPath = `studies/${studyId}/series/${seriesId}/instances/${instanceId}`;
    const request = {
        parent,
        dicomWebPath
    };

    const instance = await healthcare.projects.locations.datasets.dicomStores.studies.series.instances.retrieveInstance(
        request
    );
    const fileBytes = Buffer.from(instance.data);

    console.log(
        'Retrieved DICOM instance in current directory'
    );
    return fileBytes;
};
//=========== UTILS CODE ===========
function _sendAppMessage(ws, event, object) {
    console.log(object);

    var msg = {};
    msg.type = 'APP';
    msg.event = event;
    msg.data = object;

    ws.send(JSON.stringify(msg));
}

function _sendLogMessage(ws, text) {
    console.log(text);

    var msg = {};
    msg.type = 'LOG';
    msg.data = text;

    ws.send(JSON.stringify(msg));
}

function _sendErrorMessage(ws, err) {
    var msg = {};
    msg.type = 'ERROR';
    msg.data = err;

    ws.send(JSON.stringify(msg));
}

console.log('Listening, press Ctrl+C to stop.');
