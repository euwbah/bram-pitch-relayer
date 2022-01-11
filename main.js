let audioContext = null;
let lpfilter = null;
let hpfilter = null;
let analyser = null;
let mediaStreamSource = null;
let $text = null;
let $startBtn = null;
let $err = null;
let requestFrameID = null;
const BUFFER_SIZE = 2048;

let wss = null;


window.onload = function () {
    $text = document.querySelector('#text');
    $startBtn = document.querySelector('#start');
    $err = document.querySelector('#err');

    if (!window.requestAnimationFrame)
        window.requestAnimationFrame = window.webkitRequestAnimationFrame;

    $startBtn.onclick = beginRecording;

    let wssaddr = window.prompt("Enter websocket address: ", "127.0.0.1:4269");
    wss = new WebSocket("ws://" + wssaddr);
    wss.onerror = (e) => {
        $err.innerText = `not connected to websocket server`
    };
}

function error() {
    alert('Stream generation failed.');
}

function getUserMedia(dictionary, callback) {
    try {
        navigator.getUserMedia =
            navigator.getUserMedia ||
            navigator.webkitGetUserMedia ||
            navigator.mozGetUserMedia;
        navigator.getUserMedia(dictionary, callback, error);
    } catch (e) {
        alert('getUserMedia threw exception :' + e);
    }
}

function gotStream(stream) {
    // Create an AudioNode from the stream.
    mediaStreamSource = audioContext.createMediaStreamSource(stream);

    lpfilter = audioContext.createBiquadFilter();
    lpfilter.frequency.value = 1500;
    lpfilter.type = 'lowpass';
    mediaStreamSource.connect(lpfilter);

    hpfilter = audioContext.createBiquadFilter();
    hpfilter.frequency.value = 103.83;
    hpfilter.type = 'highpass';
    lpfilter.connect(hpfilter);

    // Connect it to the destination.
    analyser = audioContext.createAnalyser();
    analyser.fftSize = BUFFER_SIZE;
    hpfilter.connect(analyser);
    requestFrameID = window.requestAnimationFrame(updatePitch);
}

function beginRecording() {
    audioContext = new AudioContext();
    MAX_SIZE = Math.max(4, Math.floor(audioContext.sampleRate / 5000));	// corresponds to a 5kHz signal
    getUserMedia(
        {
            "audio": {
                "mandatory": {
                    "googEchoCancellation": "false",
                    "googAutoGainControl": "false",
                    "googNoiseSuppression": "false",
                    "googHighpassFilter": "false"
                },
                "optional": []
            },
        }, gotStream);

    $startBtn.display = 'none';
}

function autoCorrelate( buf, sampleRate ) {
    // Implements the ACF2+ algorithm
    var SIZE = buf.length;
    var rms = 0;

    for (var i=0;i<SIZE;i++) {
        var val = buf[i];
        rms += val*val;
    }
    rms = Math.sqrt(rms/SIZE);
    if (rms<0.01) // not enough signal
        return -1;

    var r1=0, r2=SIZE-1, thres=0.2;
    for (var i=0; i<SIZE/2; i++)
        if (Math.abs(buf[i])<thres) { r1=i; break; }
    for (var i=1; i<SIZE/2; i++)
        if (Math.abs(buf[SIZE-i])<thres) { r2=SIZE-i; break; }

    buf = buf.slice(r1,r2);
    SIZE = buf.length;

    var c = new Array(SIZE).fill(0);
    for (var i=0; i<SIZE; i++)
        for (var j=0; j<SIZE-i; j++)
            c[i] = c[i] + buf[j]*buf[j+i];

    var d=0; while (c[d]>c[d+1]) d++;
    var maxval=-1, maxpos=-1;
    for (var i=d; i<SIZE; i++) {
        if (c[i] > maxval) {
            maxval = c[i];
            maxpos = i;
        }
    }
    var T0 = maxpos;

    var x1=c[T0-1], x2=c[T0], x3=c[T0+1];
    a = (x1 + x3 - 2*x2)/2;
    b = (x3 - x1)/2;
    if (a) T0 = T0 - b/(2*a);

    return sampleRate/T0;
}

function mod31(n) {
    return ((n % 31) + 31) % 31;
}

const NOTENAMES31 = [
    'A', 'A+', 'A#', 'Bb', 'Bd',
    'B', 'B+', 'Cd',
    'C', 'C+', 'C#', 'Db', 'Dd',
    'D', 'D+', 'D#', 'Eb', 'Dd',
    'E', 'E+', 'Ed',
    'F', 'F+', 'F#', 'Gb', 'Gd',
    'G', 'G+', 'G#', 'Ab', 'Ad'
];

/***
 *
 * @param steps The number of 31 edosteps from A4
 */
function stepsToNoteName(steps) {
    let octaveReduced = mod31(steps);
    return NOTENAMES31[octaveReduced];
}

let droppedCycles = 0;
const MAX_DROP_ALLOW = 2;
const AVERAGE_N_CYCLES = 4;
const INCREASE_N_CYCLES_PER_CONSISTENT_NOTE = 0; // doesn't affect N_CYCLES_HOLD
const AVERAGE_N_CYCLES_HOLD = 12;
let history = [];
let newCandidateNote = null;
const NOTE_CONSISTENCY_REQUIREMENT = 5;
let candidateNoteConsistency = 0;
let currentNote = null;

let buf = new Float32Array(BUFFER_SIZE);

function updatePitch(deltaTime) {
    analyser.getFloatTimeDomainData(buf);
    let ac = autoCorrelate(buf, audioContext.sampleRate);
    console.log(ac);

    if (ac > 0) {
        droppedCycles = 0;
        history.unshift(ac);
        while ((candidateNoteConsistency < NOTE_CONSISTENCY_REQUIREMENT && history.length > AVERAGE_N_CYCLES + INCREASE_N_CYCLES_PER_CONSISTENT_NOTE * candidateNoteConsistency)
        || history.length > AVERAGE_N_CYCLES_HOLD)
            history.pop();

        let avgHz = history.reduce((acc, x) => acc + x, 0) / history.length;

        let centsFromA4 = 1200 * Math.log2(avgHz / 440);
        let stepsFromA4 = Math.round(31 / 1200 * centsFromA4);

        if (stepsFromA4 !== newCandidateNote) {
            candidateNoteConsistency = 0;
            newCandidateNote = stepsFromA4;
        } else if (candidateNoteConsistency < NOTE_CONSISTENCY_REQUIREMENT)
            candidateNoteConsistency++;
        else {
            currentNote = stepsFromA4;
        }

        if (currentNote !== null) {
            let centOffset = centsFromA4 - 1200 / 31 * currentNote;
            let sign = centOffset > 0 ? '+' : '-';
            let octaveNumber = 4 + Math.floor((currentNote + 24) / 31); // A is 24 dieses above Cd

            $text.innerText = `${stepsToNoteName(currentNote)}${octaveNumber}
            ${sign} ${Math.abs(centOffset).toFixed(2)}
            ${avgHz.toFixed(2)} Hz`;
        }
    } else {
        if (history.length > 0)
            history.pop();

        droppedCycles++;
        currentNote = null;

        if (droppedCycles > MAX_DROP_ALLOW) {
            $text.innerText = `Can't make out signal`;
        }
    }

    requestFrameID = window.requestAnimationFrame(updatePitch);
}