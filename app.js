/**
 * Copyright (c) Microsoft Corporation
 *  All Rights Reserved
 *  MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this
 * software and associated documentation files (the 'Software'), to deal in the Software
 * without restriction, including without limitation the rights to use, copy, modify,
 * merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to the following
 * conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS
 * OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
 * WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
 * OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

'use strict';

/******************************************************************************
 * Module dependencies.
 *****************************************************************************/
const   express         = require('express')
      , cookieParser    = require('cookie-parser')
      , expressSession  = require('express-session')
      , bodyParser      = require('body-parser')
      , methodOverride  = require('method-override')
      , passport        = require('passport')
      , handlebars      = require('express-handlebars')
      , OIDCStrategy    = require('passport-azure-ad').OIDCStrategy
      , config          = require('./config');


const loggedInUsers = [];

const findUser = (oid, callback) => {
  const user = loggedInUsers.find((user) => user.oid === oid);
  return callback(null, user);
};

/******************************************************************************
 * Set up passport in the app 
 ******************************************************************************/
//-----------------------------------------------------------------------------
// To support persistent login sessions, Passport needs to be able to
// serialize users into and deserialize users out of the session.  Typically,
// this will be as simple as storing the user ID when serializing, and finding
// the user by ID when deserializing.
//-----------------------------------------------------------------------------
passport.serializeUser((user, done) => {
  done(null, user.oid);
});

passport.deserializeUser((oid, done) => {
  findUser(oid, (err, user) => done(err, user));
});

//-----------------------------------------------------------------------------
// Use the OIDCStrategy within Passport.
// 
// Strategies in passport require a `verify` function, which accepts credentials
// (in this case, the `oid` claim in id_token), and invoke a callback to find
// the corresponding user object.
// 
// The following are the accepted prototypes for the `verify` function
// (1) function(iss, sub, done)
// (2) function(iss, sub, profile, done)
// (3) function(iss, sub, profile, access_token, refresh_token, done)
// (4) function(iss, sub, profile, access_token, refresh_token, params, done)
// (5) function(iss, sub, profile, jwtClaims, access_token, refresh_token, params, done)
// (6) prototype (1)-(5) with an additional `req` parameter as the first parameter
//
// To do prototype (6), passReqToCallback must be set to true in the config.
//-----------------------------------------------------------------------------
passport.use(new OIDCStrategy(config.creds, 
  (iss, sub, profile, accessToken, refreshToken, done) => {

    if (!profile.oid) {
      return done(new Error("No oid found"), null);
    }

    // asynchronous verification, for effect...
    process.nextTick(() => {
      findUser(profile.oid, (err, user) => {

        if (err) {
          return done(err, null);
        }

        if (!user) {
          // "Auto-registration"
          loggedInUsers.push(profile);
          return done(null, profile);
        }

        return done(null, user);
      });
    });
  }
));


//-----------------------------------------------------------------------------
// Config the app, include middlewares
//-----------------------------------------------------------------------------
const app = express();

app.engine('html', handlebars());
app.set('view engine', 'html');
app.set('views', __dirname + '/views');
app.use(methodOverride());
app.use(cookieParser());
app.use(expressSession({ secret: 'keyboard cat', resave: true, saveUninitialized: false }));
app.use(bodyParser.urlencoded({ extended : true }));

// Initialize Passport!  Also use passport.session() middleware, to support
// persistent login sessions (recommended).
app.use(passport.initialize());
app.use(passport.session());
app.use(app.router);

//-----------------------------------------------------------------------------
// Set up the route controller
//
// 1. For 'login' route and 'returnURL' route, use `passport.authenticate`. 
// This way the passport middleware can redirect the user to login page, receive
// id_token etc from returnURL.
//
// 2. For the routes you want to check if user is already logged in, use 
// `ensureAuthenticated`. It checks if there is an user stored in session, if not
// it will call `passport.authenticate` to ask for user to log in.
//-----------------------------------------------------------------------------
const ensureAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) { 
    return next(); 
  }

  res.redirect('/login');
};

app.get('/', (req, res) => {
  let userString = req.user ? JSON.stringify(req.user).replace(/\\"/g, '"') : '';
  res.render('index', { user: req.user, userString: userString });
});

app.get('/api', ensureAuthenticated, (req, res) => {
  res.send({ message: 'Respone from API endpoint'});
});

app.get('/login', 
  (req, res, next) => {

    const authenticationOptions = {
      response: res,                      // required
      resourceURL: config.resourceURL,    // optional. Provide a value if you want to specify the resource.
      customState: 'my_state',            // optional. Provide a value if you want to provide custom state value.
      failureRedirect: '/'
    };

    passport.authenticate('azuread-openidconnect', authenticationOptions)(req, res, next);
  },

  (req, res) => res.redirect('/')
);

// 'GET returnURL'
// `passport.authenticate` will try to authenticate the content returned in
// query (such as authorization code). If authentication fails, user will be
// redirected to '/' (home page); otherwise, it passes to the next middleware.
app.get('/auth/openid/return',
  (req, res, next) => {

    const authenticationOptions = { 
      response: res,                      // required
      failureRedirect: '/'  
    };

    passport.authenticate('azuread-openidconnect', authenticationOptions)(req, res, next);
  },
  (req, res) => {
    res.redirect('/');
  });

// 'POST returnURL'
// `passport.authenticate` will try to authenticate the content returned in
// body (such as authorization code). If authentication fails, user will be
// redirected to '/' (home page); otherwise, it passes to the next middleware.
app.post('/auth/openid/return',
  (req, res, next) => {
    const authenticationOptions = { 
      response: res,  // required
      failureRedirect: '/'  
    };
    
    passport.authenticate('azuread-openidconnect', authenticationOptions)(req, res, next);
  },
  (req, res) => {
    res.redirect('/');
  });

// 'logout' route, logout from passport, and destroy the session with AAD.
app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    req.logOut();
    res.redirect(config.destroySessionUrl);
  });
});

app.listen(config.serverPort);