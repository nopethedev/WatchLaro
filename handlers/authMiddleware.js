
const checkSession = function(req, res, next) {
    if (req.session.user?.uuid) {
        next();
    } else {
        //res.render('accessdenied.ejs')
        res.redirect(403, '/login')
    }
}

const checkManager = function(req,res, next) {
    if (req.session.user?.rank){
        if(req.session.user.rank == "manager" || req.session.user.rank == "admin"){
            next();
        }else{
            res.status(403);
            res.render('accessDenied.js');
        }
    }else{
        res.status(403);
        res.render('accessDenied.ejs');
    }
}

const checkAdmin = function(req,res, next) {
    if (req.session.user?.rank){
        if(req.session.user.rank == "admin"){
            next();
        }else{
            res.status(403);
            res.render('accessDenied.js');
        }
    }else{
        res.status(403);
        res.render('accessDenied.ejs');
    }
}

export default {checkSession, checkManager, checkAdmin}