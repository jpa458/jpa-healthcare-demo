
const sitePort=(window.location.port ===  80) ? '' : ':' + window.location.port;
const socketURI = 'ws://' + window.location.hostname + sitePort +'/ws';
document.getElementById('process_button').disabled = true;
document.getElementById('delete_button').disabled = true;
const socket = new WebSocket(socketURI);

socket.onopen = function () {
  console.log('Open');
  document.getElementById('process_button').disabled = false;
  document.getElementById('delete_button').disabled = false;
};

socket.onerror = function (error) {
  console.log('WebSocket Error ' + error);
};

socket.onclose = function(event) {
  if (event.wasClean) {
    console.log(`[close] Connection closed cleanly, code=${event.code} reason=${event.reason}`);
  } else {
    // e.g. server process killed or network down
    // event.code is usually 1006 in this case
    console.log('[close] Connection died');
    alert('Lost connection with server, refresh the page to start again');
  }
};

socket.onmessage = function (event) {
  console.log(event.data);

  msg = JSON.parse(event.data);
  console.log(msg.data);

  if (msg.type === "LOG") {
    let li = document.createElement('li');
    li.innerText = msg.data;
    document.querySelector('#chat').append(li);
  } else if (msg.type === "APP") {

    if (msg.event==="INFERENCE_COMPLETE") {
      document.getElementById('studyResultsContainer').style.display = "block";

      //load image
      var data = msg.data.sourceInstance;
      document.getElementById("image").src="dicomImage?studyId=" + data.studyId + "&seriesId=" + data.seriesId + "&instanceId=" + data.instanceId ;

      //load study data including the inference data
      inferenceData = msg.data.inferenceInstance;
      getDicomStudy(inferenceData.studyId, inferenceData.seriesId, inferenceData.instanceId) ;

    } else if (msg.type === "ERROR") {
      alert(msg.data);
    }
  }
};

function process(){
  document.getElementById('results').style.display = "block";
  var msg = {};
  msg.type = "INSERT";
  msg.gcsUri = document.getElementById('gcsUri').value;
  console.log("Process : " + JSON.stringify(msg));
  socket.send(JSON.stringify(msg));
};

function cleanup(){
  var msg = {};
  msg.type = "DELETE";
  var params = document.getElementById('gcsUri').value.split('/');

  msg.key = params[4]+'/'+params[5]+'/'+params[6].slice(0, -4);
  console.log("Delete : " + JSON.stringify(msg));
  socket.send(JSON.stringify(msg));
  document.getElementById("chat").innerHTML = "";
  document.getElementById("studyResults").innerHTML = "";
  document.getElementById("image").src = "";
};

function getDicomStudy(studyId, seriesId, instanceId) {

  var params = "?studyId="+studyId+"&seriesId="+seriesId+"&instanceId="+instanceId
  var oReq = new XMLHttpRequest();
  oReq.open("GET", "dicomInstance"+params, true);
  oReq.responseType = "arraybuffer";

  oReq.onload = function(oEvent) {
    var arrayBuffer = oReq.response;
        console.log("recieved dicom");
        dataSet = dicomParser.parseDicom(new Uint8Array(arrayBuffer));
        console.log("parsing dicom");

        var output = [];
        dumpDataSet(dataSet, output);
        console.log("dumping");
        document.getElementById('studyResults').innerHTML = '<ul>' + output.join('') + '</ul>';
    };

  oReq.send();
}

function toggleInfo() {
  $('#infoCard').collapse('toggle');
}
//See the following repo for example code below : https://github.com/cornerstonejs/dicomParser

function isASCII(str) {
    return /^[\x00-\x7F]*$/.test(str);
}

// This function iterates through dataSet recursively and adds new HTML strings
// to the output array passed into it
function dumpDataSet(dataSet, output) {
    // the dataSet.elements object contains properties for each element parsed.  The name of the property
    // is based on the elements tag and looks like 'xGGGGEEEE' where GGGG is the group number and EEEE is the
    // element number both with lowercase hexadecimal letters.  For example, the Series Description DICOM element 0008,103E would
    // be named 'x0008103e'.  Here we iterate over each property (element) so we can build a string describing its
    // contents to add to the output array
    try {
        for (var propertyName in dataSet.elements) {
            var element = dataSet.elements[propertyName];

            // The output string begins with the element tag, length and VR (if present).  VR is undefined for
            // implicit transfer syntaxes
            var text = element.tag;
            text += " length=" + element.length;

            if (element.hadUndefinedLength) {
                text += " <strong>(-1)</strong>";
            }
            text += "; ";

            if (element.vr) {
                text += " VR=" + element.vr + "; ";
            }

            var color = 'black';

            // Here we check for Sequence items and iterate over them if present.  items will not be set in the
            // element object for elements that don't have SQ VR type.  Note that implicit little endian
            // sequences will are currently not parsed.
            if (element.items) {
                output.push('<li>' + text + '</li>');
                output.push('<ul>');

                // each item contains its own data set so we iterate over the items
                // and recursively call this function
                var itemNumber = 0;
                element.items.forEach(function (item) {
                    output.push('<li>Item #' + itemNumber++ + ' ' + item.tag + '</li>')
                    output.push('<ul>');
                    dumpDataSet(item.dataSet, output);
                    output.push('</ul>');
                });
                output.push('</ul>');
            }
            else if (element.fragments) {
                output.push('<li>' + text + '</li>');
                output.push('<ul>');

                // each item contains its own data set so we iterate over the items
                // and recursively call this function
                var itemNumber = 0;
                element.fragments.forEach(function (fragment) {
                    var basicOffset;
                    if(element.basicOffsetTable) {
                        basicOffset = element.basicOffsetTable[itemNumber];
                    }

                    var str = '<li>Fragment #' + itemNumber++ + ' offset = ' + fragment.offset;
                    str += '(' + basicOffset + ')';
                    str += '; length = ' + fragment.length + '</li>';
                    output.push(str);
                });
                output.push('</ul>');
            }
            else {

                // if the length of the element is less than 512 we try to show it.  We put this check in
                // to avoid displaying large strings which makes it harder to use.
                if (element.length < 512) {
                    // Since the dataset might be encoded using implicit transfer syntax and we aren't using
                    // a data dictionary, we need some simple logic to figure out what data types these
                    // elements might be.  Since the dataset might also be explicit we could be switch on the
                    // VR and do a better job on this, perhaps we can do that in another example

                    // First we check to see if the element's length is appropriate for a UI or US VR.
                    // US is an important type because it is used for the
                    // image Rows and Columns so that is why those are assumed over other VR types.
                    if (element.length === 2) {
                        text += " (" + dataSet.uint16(propertyName) + ")";
                    }
                    else if (element.length === 4) {
                        text += " (" + dataSet.uint32(propertyName) + ")";
                    }

                    // Next we ask the dataset to give us the element's data in string form.  Most elements are
                    // strings but some aren't so we do a quick check to make sure it actually has all ascii
                    // characters so we know it is reasonable to display it.
                    var str = dataSet.string(propertyName);
                    var stringIsAscii = isASCII(str);

                    if (stringIsAscii) {
                        // the string will be undefined if the element is present but has no data
                        // (i.e. attribute is of type 2 or 3 ) so we only display the string if it has
                        // data.  Note that the length of the element will be 0 to indicate "no data"
                        // so we don't put anything here for the value in that case.
                        if (str !== undefined) {
                            text += '"' + str + '"';
                        }
                    }
                    else {
                        if (element.length !== 2 && element.length !== 4) {
                            color = '#C8C8C8';
                            // If it is some other length and we have no string
                            text += "<i>binary data</i>";
                        }
                    }

                    if (element.length === 0) {
                        color = '#C8C8C8';
                    }

                }
                else {
                    color = '#C8C8C8';

                    // Add text saying the data is too long to show...
                    text += "<i>data too long to show</i>";
                }
                // finally we add the string to our output array surrounded by li elements so it shows up in the
                // DOM as a list
                output.push('<li style="color:' + color + ';">' + text + '</li>');
            }
        }
    } catch(err) {
        var ex = {
            exception: err,
            output: output
        }
        throw ex;
    }
}
